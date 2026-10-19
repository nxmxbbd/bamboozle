import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import {
  Accessory,
  CameraController,
  Characteristic,
  Service,
  uuid,
  type CameraStreamingDelegate,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
  type PrepareStreamResponse,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  type StreamingRequest,
  type StreamRequestCallback,
} from 'hap-nodejs';
import { VERSION } from '../version.ts';
import {
  CATEGORY_CAMERA,
  H264_LEVELS,
  H264_PROFILES,
  SRTP_AES_CM_128_HMAC_SHA1_80,
  STREAM_RECONFIGURE,
  STREAM_START,
  STREAM_STOP,
} from '../homekit/hap-constants.ts';
import { homeKitName } from '../homekit/names.ts';
import { runForOutput, snapshotArgs, stopProcess, streamArgs, type FfmpegSettings } from './ffmpeg.ts';
import { OverlayFiles, overlayContent, overlayFilter, type OverlayFonts, type OverlayInput } from './overlay.ts';
import { isSamePeer, localMediaAddress, type PeerAddress, socketHost, viewerPeer } from './peer.ts';

export interface PrinterCameraOptions {
  name: string;
  serial: string;
  model?: string;
  source: string;
  overlayDir: string;
  fonts: OverlayFonts;
  ffmpeg: FfmpegSettings;
  log?: Pick<Console, 'log' | 'warn'>;
  /** A stream whose receiver sent RTCP and then went quiet this long is ended. */
  streamIdleMs?: number;
  /** A prepared stream that is never started gives its port back after this. */
  preparedTtlMs?: number;
  /** A cached snapshot older than this is refreshed in the background (default SNAPSHOT_FRESH_MS). */
  snapshotFreshMs?: number;
  /** Test seam: called with each stream's UDP socket right after it is created. */
  onStreamSocket?: (sessionID: string, socket: Socket) => void;
}

// 16:9 only: the overlay canvas is 16:9 and must not be stretched.
const RESOLUTIONS: Array<[number, number, number]> = [
  [1920, 1080, 30],
  [1280, 720, 30],
  [640, 360, 30],
  [480, 270, 30],
  [320, 180, 30],
];

/** A snapshot older than this is still served, but a fresh one is rendered. */
export const SNAPSHOT_FRESH_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 12_000;
/** While background refreshes keep failing, repeat the warning every this many failures. */
const REFRESH_FAILURE_LOG_EVERY = 30;
/** While overlay writes keep failing (a full disk), repeat the warning every this many failures. */
const OVERLAY_FAILURE_LOG_EVERY = 30;
/** Distinct snapshot sizes kept in memory (least recently used evicted). */
export const SNAPSHOT_CACHE_SIZES = 4;
/** Snapshot renders waiting or running at once; more are refused. */
export const SNAPSHOT_QUEUE_LIMIT = 4;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;

const DEFAULT_STREAM_IDLE_MS = 30_000;
const IDLE_CHECK_MS = 5_000;
const DEFAULT_PREPARED_TTL_MS = 30_000;

/**
 * binding → prepared → starting → running, and from any of them → ending.
 * 'ending' lasts until the socket is closed and ffmpeg has exited.
 */
type StreamState = 'binding' | 'prepared' | 'starting' | 'running' | 'ending';

/** One live-video session, from prepareStream until it has fully ended. */
interface Stream {
  state: StreamState;
  /**
   * Bound to the port we advertise for the session (see #datagram), and to
   * the address we advertise when our local address is known (see
   * prepareStream).
   */
  socket: Socket;
  /** Settles on the socket's 'close' (a next-tick event after close()). */
  closed: Promise<void>;
  /**
   * The only sender whose RTCP counts (none if the target is not an
   * address): the target in canonical form, held to the interface of the
   * HAP connection when it is link-local (see viewerPeer).
   */
  peerKey: PeerAddress | null;
  /**
   * Where the video and the return-path datagram go: peerKey as a host
   * string for the stream's socket family (see socketHost), with our zone
   * when it has one, so the viewer's own zone never reaches the socket or
   * ffmpeg; an IPv4 viewer on an IPv6 stream is written IPv4-mapped. When
   * the target is not an address (peerKey is null), the target as given.
   */
  destination: string;
  ipv6: boolean;
  targetPort: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
  ssrc: number;
  /** Gives the port back when a prepared stream is never started. */
  expiry: NodeJS.Timeout | null;
  child: ChildProcess | null;
  watchdog: NodeJS.Timeout | null;
  lastRtcp: number | null;
  /** HomeKit callbacks not answered yet; each is answered exactly once. */
  onPrepared: PrepareStreamCallback | null;
  onStarted: StreamRequestCallback | null;
  ending: Promise<void> | null;
}

interface CachedSnapshot {
  image: Buffer;
  at: number;
}

function validSize(width: unknown, height: unknown): width is number {
  return (
    Number.isInteger(width) && Number.isInteger(height) &&
    (width as number) >= 16 && (width as number) <= MAX_WIDTH &&
    (height as number) >= 16 && (height as number) <= MAX_HEIGHT
  );
}

function closeSocket(socket: Socket): void {
  try {
    socket.close();
  } catch {
    // already closed
  }
}

/** An RTCP header: version 2 and a packet type from 200 (SR) to 206 (PSFB). */
function looksLikeRtcp(packet: Buffer): boolean {
  return packet.length >= 8 && packet[0]! >> 6 === 2 && packet[1]! >= 200 && packet[1]! <= 206;
}

/**
 * The camera of one printer: snapshots for the Home tile and live video,
 * both with the status overlay.
 *
 * Snapshots are served stale-while-revalidate (a slow ffmpeg never blocks
 * the bridge), validated, rendered one at a time and cached for a few sizes.
 *
 * Each live stream is one record, registered before anything asynchronous
 * happens and dropped only once its socket is closed and its ffmpeg has
 * exited, so STOP or stop() at any moment finds and ends it. A stream ends
 * on STOP, when ffmpeg exits, on a socket error, or when the viewer's RTCP
 * goes quiet. The Home app sends its RTCP to the port we advertised, from
 * the port it receives the video on (seen with an iPhone; see
 * #openReturnPath for host firewalls). The idle check is failure-safe: if no
 * RTCP ever arrives, it is never armed and a stream is never ended on a
 * guess.
 */
export class PrinterCamera implements CameraStreamingDelegate {
  readonly accessory: Accessory;
  readonly controller: CameraController;
  readonly #options: PrinterCameraOptions;
  readonly #files: OverlayFiles;
  readonly #filter: string;
  readonly #idleMs: number;
  readonly #preparedTtlMs: number;
  readonly #freshMs: number;
  /** Failed background refreshes in a row, per snapshot size. */
  #refreshFailures = new Map<string, number>();
  /** Failed overlay writes in a row. */
  #overlayFailures = 0;
  readonly #streams = new Map<string, Stream>();
  readonly #snapshots = new Map<string, CachedSnapshot>();
  readonly #rendering = new Map<string, Promise<Buffer>>();
  readonly #abort = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #stopping = false;

  constructor(options: PrinterCameraOptions) {
    this.#options = options;
    this.#idleMs = options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS;
    this.#preparedTtlMs = options.preparedTtlMs ?? DEFAULT_PREPARED_TTL_MS;
    this.#freshMs = options.snapshotFreshMs ?? SNAPSHOT_FRESH_MS;
    this.#files = new OverlayFiles(options.overlayDir);
    this.#filter = overlayFilter(this.#files, options.fonts);

    this.controller = new CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [SRTP_AES_CM_128_HMAC_SHA1_80],
        video: { codec: { profiles: H264_PROFILES, levels: H264_LEVELS }, resolutions: RESOLUTIONS },
      },
    });

    this.accessory = new Accessory(homeKitName(`${options.name} Camera`), uuid.generate(`bamboozle:${options.serial}:camera`));
    this.accessory.category = CATEGORY_CAMERA;
    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Bambu Lab')
      .setCharacteristic(Characteristic.Model, options.model ?? '3D printer')
      .setCharacteristic(Characteristic.SerialNumber, options.serial)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
    this.accessory.configureController(this.controller);
  }

  /** Streams sending video. */
  get activeStreams(): number {
    let running = 0;
    for (const stream of this.#streams.values()) if (stream.state === 'running') running++;
    return running;
  }

  /** Streams in any state, including those being set up or torn down. */
  get trackedStreams(): number {
    return this.#streams.size;
  }

  get cachedSnapshotSizes(): number {
    return this.#snapshots.size;
  }

  get refreshStreakSizes(): number {
    return this.#refreshFailures.size;
  }

  /**
   * Push the latest printer state into the overlay (snapshots and live video).
   * A write that fails (a full disk) is not fatal: video keeps the last text,
   * the next update writes again, and a streak of failures is reported on its
   * first failure and then every OVERLAY_FAILURE_LOG_EVERY failures.
   */
  update(input: OverlayInput): void {
    const content = overlayContent(input);
    try {
      this.#files.write(content);
    } catch (error) {
      this.#overlayFailures++;
      if (this.#overlayFailures === 1 || this.#overlayFailures % OVERLAY_FAILURE_LOG_EVERY === 0) {
        this.#options.log?.warn(`[${this.#options.name}] overlay text not written (${this.#overlayFailures}x): ${(error as Error).message}`);
      }
      return;
    }
    if (this.#overlayFailures === 0) return;
    this.#options.log?.log(`[${this.#options.name}] overlay text written again after ${this.#overlayFailures} failed attempt(s)`);
    this.#overlayFailures = 0;
  }

  // --- snapshots -------------------------------------------------------------

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const { width, height } = request;
    if (this.#stopping) return callback(new Error('camera is stopping'));
    if (!validSize(width, height)) return callback(new Error(`invalid snapshot size ${String(width)}x${String(height)}`));
    const key = `${width}x${height}`;
    const cached = this.#snapshots.get(key);
    if (cached) {
      // Refresh the LRU position.
      this.#snapshots.delete(key);
      this.#snapshots.set(key, cached);
      callback(undefined, cached.image);
      // Only the request that starts a refresh reports on it, so one failure counts once.
      if (Date.now() - cached.at > this.#freshMs && !this.#rendering.has(key)) {
        this.#render(width, height).then(
          () => this.#refreshed(key),
          (error: Error) => this.#refreshFailed(key, error),
        );
      }
      return;
    }
    this.#render(width, height).then(
      (image) => {
        this.#refreshed(key);
        callback(undefined, image);
      },
      (error: Error) => {
        if (!this.#stopping) this.#options.log?.warn(`[${this.#options.name}] snapshot failed: ${error.message}`);
        callback(error);
      },
    );
  }

  /** Render a snapshot: one ffmpeg at a time, shared by requests of the same size. */
  #render(width: number, height: number): Promise<Buffer> {
    const key = `${width}x${height}`;
    const running = this.#rendering.get(key);
    if (running) return running;
    if (this.#queued >= SNAPSHOT_QUEUE_LIMIT) return Promise.reject(new Error('too many snapshot requests'));
    const { ffmpeg, source } = this.#options;
    this.#queued++;
    const job = this.#queue
      .then(() => runForOutput(ffmpeg.path, snapshotArgs(source, this.#filter, width, height), SNAPSHOT_TIMEOUT_MS, this.#abort.signal))
      .then((image) => {
        this.#snapshots.delete(key);
        this.#snapshots.set(key, { image, at: Date.now() });
        while (this.#snapshots.size > SNAPSHOT_CACHE_SIZES) {
          const oldest = this.#snapshots.keys().next().value as string;
          this.#snapshots.delete(oldest);
          this.#refreshFailures.delete(oldest); // a streak lives as long as its image
        }
        return image;
      })
      .finally(() => {
        this.#queued--;
        this.#rendering.delete(key);
      });
    this.#queue = job.catch(() => {});
    this.#rendering.set(key, job);
    return job;
  }

  /**
   * A background refresh failed. The Home app keeps the last good image, so
   * nothing looks broken there: say so in the log, on the first failure of a
   * streak and then every REFRESH_FAILURE_LOG_EVERY failures. Streaks are
   * per size, so a size that works does not interrupt one that keeps failing.
   */
  #refreshFailed(key: string, error: Error): void {
    if (this.#stopping) return;
    const failures = (this.#refreshFailures.get(key) ?? 0) + 1;
    // Keep the streak only while the size is cached (it may have been evicted mid-refresh).
    if (this.#snapshots.has(key)) this.#refreshFailures.set(key, failures);
    else this.#refreshFailures.delete(key);
    if (failures !== 1 && failures % REFRESH_FAILURE_LOG_EVERY !== 0) return;
    const cached = this.#snapshots.get(key);
    const age = cached ? `, serving an image from ${Math.round((Date.now() - cached.at) / 1000)} s ago` : '';
    this.#options.log?.warn(`[${this.#options.name}] ${key} snapshot refresh failed (${failures}x): ${error.message}${age}`);
  }

  /** A snapshot of this size rendered: end its streak of failed refreshes, if there was one. */
  #refreshed(key: string): void {
    const failures = this.#refreshFailures.get(key);
    if (failures === undefined) return;
    this.#refreshFailures.delete(key);
    this.#options.log?.log(`[${this.#options.name}] ${key} snapshots refresh again after ${failures} failed attempt(s)`);
  }

  // --- live video --------------------------------------------------------------

  /**
   * Bind a stream's socket and answer with its port. The viewer sends its
   * RTCP to the address HAP-NodeJS advertises in the SetupEndpoints
   * response. When our end of the HAP connection (request.sourceAddress)
   * is an address of the stream's family (see localMediaAddress), the
   * socket is bound to it, with its zone, and its canonical address
   * without a zone is advertised as addressOverride. Otherwise the socket
   * binds on all interfaces and HAP-NodeJS advertises an address of the
   * connection's interface of its own choosing. Our own end of a connection
   * can be bound, so there is no fallback: a bind error fails the prepare
   * (see #socketError).
   */
  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const { sessionID } = request;
    if (this.#stopping) return callback(new Error('camera is stopping'));
    if (this.#streams.has(sessionID)) return callback(new Error('stream is already prepared'));
    const ipv6 = request.addressVersion === 'ipv6';
    const local = localMediaAddress(request.sourceAddress, ipv6);
    const peerKey = viewerPeer(request.targetAddress, request.sourceAddress);
    const socket = createSocket(ipv6 ? 'udp6' : 'udp4');
    const stream: Stream = {
      state: 'binding',
      socket,
      // Listening from the start: close() is only ever called after this.
      closed: new Promise<void>((resolve) => socket.once('close', () => resolve())),
      peerKey,
      destination: peerKey === null ? request.targetAddress : socketHost(peerKey, ipv6),
      ipv6,
      targetPort: request.video.port,
      srtpKey: request.video.srtp_key,
      srtpSalt: request.video.srtp_salt,
      ssrc: CameraController.generateSynchronisationSource(),
      expiry: null,
      child: null,
      watchdog: null,
      lastRtcp: null,
      onPrepared: callback,
      onStarted: null,
      ending: null,
    };
    // Registered before the first asynchronous step, so STOP or stop() finds it.
    this.#streams.set(sessionID, stream);
    // Permanent listener: an 'error' with no listener would crash the process.
    socket.on('error', (error) => this.#socketError(sessionID, stream, error));
    socket.on('message', (packet, sender) => this.#datagram(stream, packet, sender));
    this.#options.onStreamSocket?.(sessionID, socket);
    // Without an address, the socket binds on all interfaces.
    socket.bind(0, local === null ? undefined : socketHost(local), () => {
      // A socket closed while binding never gets here; this covers a
      // cancellation that left it open.
      if (stream.state !== 'binding' || this.#stopping) {
        closeSocket(socket);
        this.#answerPrepare(stream, new Error(this.#stopping ? 'camera is stopping' : 'cancelled'));
        if (stream.state === 'binding') void this.#end(sessionID, stream);
        return;
      }
      stream.state = 'prepared';
      stream.expiry = setTimeout(() => {
        this.#options.log?.log(`[${this.#options.name}] prepared stream was never started; releasing its port`);
        this.#endAndTell(sessionID, stream);
      }, this.#preparedTtlMs);
      this.#answerPrepare(stream, undefined, {
        ...(local === null ? {} : { addressOverride: local.address }),
        video: { port: socket.address().port, ssrc: stream.ssrc, srtp_key: stream.srtpKey, srtp_salt: stream.srtpSalt },
      });
    });
  }

  #answerPrepare(stream: Stream, error?: Error, response?: PrepareStreamResponse): void {
    const callback = stream.onPrepared;
    stream.onPrepared = null;
    callback?.(error, response);
  }

  #answerStart(stream: Stream, error?: Error): void {
    const callback = stream.onStarted;
    stream.onStarted = null;
    callback?.(error);
  }

  #socketError(sessionID: string, stream: Stream, error: Error): void {
    if (stream.state === 'ending') return;
    const { name, log } = this.#options;
    if (stream.state === 'binding') {
      log?.warn(`[${name}] stream socket failed to bind: ${error.message}`);
      this.#answerPrepare(stream, error);
      void this.#end(sessionID, stream);
      return;
    }
    log?.warn(`[${name}] stream socket error: ${error.message}; ending the stream`);
    if (stream.state === 'starting') {
      // A failed START makes HAP-NodeJS close the session itself.
      this.#answerStart(stream, error);
      void this.#end(sessionID, stream);
    } else {
      this.#endAndTell(sessionID, stream);
    }
  }

  /**
   * Viewer activity, for the idle check: the viewer's RTCP, sent to the
   * port we advertised in the prepare response. Only RTCP-shaped packets
   * from the viewer (Stream.peerKey) count; anything else is ignored.
   */
  #datagram(stream: Stream, packet: Buffer, sender: RemoteInfo): void {
    if (stream.state !== 'running') return;
    if (!isSamePeer(stream.peerKey, sender.address) || !looksLikeRtcp(packet)) return;
    if (stream.lastRtcp === null) this.#options.log?.log(`[${this.#options.name}] receiving RTCP from the viewer`);
    stream.lastRtcp = Date.now();
  }

  /**
   * Send one empty datagram from the advertised port to the port the viewer
   * receives the video on, at Stream.destination. An iPhone sends its RTCP
   * from that port to the advertised address and port; a stateful host
   * firewall (ufw, firewalld) drops those packets as unsolicited unless
   * this socket has sent to the viewer's address and port first, from the
   * advertised address, which makes them replies. When our local address is
   * known, the socket is bound to the address we advertise (see
   * prepareStream), so the source and the advertised address agree by
   * construction; otherwise the source is left to routing and can differ.
   * An empty packet is not valid SRTP, so the viewer discards it. If
   * sending fails, the idle check just stays unarmed.
   */
  #openReturnPath(stream: Stream): void {
    const { name, log } = this.#options;
    const failed = (error: Error) => log?.warn(`[${name}] could not open the RTCP return path: ${error.message}`);
    try {
      stream.socket.send(Buffer.alloc(0), stream.targetPort, stream.destination, (error) => {
        if (error && stream.state === 'running') failed(error);
      });
    } catch (error) {
      failed(error as Error);
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === STREAM_START) return this.#start(request.sessionID, request.video, callback);
    if (request.type === STREAM_RECONFIGURE) return callback(); // keeps the running encoder settings
    if (request.type === STREAM_STOP) {
      void this.#end(request.sessionID).then(() => callback());
      return;
    }
    callback();
  }

  #start(sessionID: string, video: Extract<StreamingRequest, { type: typeof STREAM_START }>['video'], callback: StreamRequestCallback): void {
    const { name, ffmpeg, source } = this.#options;
    const stream = this.#streams.get(sessionID);
    // stop() has already moved every stream to 'ending'.
    if (!stream || stream.state !== 'prepared') return callback(new Error(this.#stopping ? 'camera is stopping' : 'stream was not prepared'));
    stream.state = 'starting';
    stream.onStarted = callback;
    if (stream.expiry) clearTimeout(stream.expiry);
    stream.expiry = null;
    const args = streamArgs(source, this.#filter, ffmpeg, {
      width: video.width,
      height: video.height,
      fps: video.fps,
      bitrate: video.max_bit_rate,
      profile: video.profile,
      payloadType: video.pt,
      mtu: video.mtu,
      ssrc: stream.ssrc,
      targetAddress: stream.destination,
      ipv6: stream.ipv6,
      targetPort: stream.targetPort,
      srtpKey: stream.srtpKey,
      srtpSalt: stream.srtpSalt,
    });

    let child: ChildProcess;
    try {
      child = spawn(ffmpeg.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      // Invalid arguments (such as a NUL byte in the path) throw instead of emitting 'error'.
      this.#options.log?.warn(`[${name}] stream failed to start: ${(error as Error).message}`);
      this.#answerStart(stream, error as Error);
      void this.#end(sessionID, stream);
      return;
    }
    stream.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));

    child.once('spawn', () => {
      if (stream.state !== 'starting') {
        // STOP or stop() came in while it was starting; that is ending it.
        this.#answerStart(stream, new Error('cancelled'));
        void this.#end(sessionID, stream);
        return;
      }
      stream.state = 'running';
      this.#openReturnPath(stream);
      stream.watchdog = setInterval(() => {
        // Armed only once RTCP has been seen: never end a stream on a guess.
        if (stream.state === 'running' && stream.lastRtcp !== null && Date.now() - stream.lastRtcp > this.#idleMs) {
          this.#options.log?.warn(`[${name}] stream receiver went quiet; ending the stream`);
          this.#endAndTell(sessionID, stream);
        }
      }, Math.min(IDLE_CHECK_MS, this.#idleMs));
      this.#options.log?.log(`[${name}] streaming ${video.width}x${video.height}@${video.fps} ${video.max_bit_rate} kbit/s`);
      this.#answerStart(stream);
    });
    // Permanent listener (a second 'error', e.g. from kill, must not crash).
    child.on('error', (error) => {
      if (stream.state !== 'starting') return; // 'close' handles a running process that fails
      this.#options.log?.warn(`[${name}] stream failed to start: ${error.message}`);
      this.#answerStart(stream, error);
      void this.#end(sessionID, stream);
    });
    child.once('close', (code, signal) => {
      if (stream.state !== 'running') return; // ended deliberately, or never started
      this.#options.log?.warn(`[${name}] stream ended (${signal ?? code}): ${stderr.trim().split('\n').slice(-2).join(' | ')}`);
      this.#endAndTell(sessionID, stream);
    });
  }

  /**
   * End a prepared or running stream we decided to end, and tell the Home
   * app right away. HAP-NodeJS keeps a session's slot in use until STOP, a
   * failed request, this call or the controller disconnecting; without it a
   * stream we dropped would still count against cameraStreamCount.
   */
  #endAndTell(sessionID: string, stream: Stream): void {
    void this.#end(sessionID, stream); // no longer active at once; ffmpeg stops in the background
    this.controller.forceStopStreamingSession(sessionID);
  }

  /**
   * End a stream in any state. Idempotent: every caller gets the same
   * promise, which settles once the socket has emitted 'close' and ffmpeg
   * has exited; only then is the record dropped. Unanswered HomeKit
   * callbacks fail.
   */
  #end(sessionID: string, stream = this.#streams.get(sessionID)): Promise<void> {
    if (!stream) return Promise.resolve();
    if (stream.ending) return stream.ending;
    stream.state = 'ending';
    if (stream.expiry) clearTimeout(stream.expiry);
    if (stream.watchdog) clearInterval(stream.watchdog);
    stream.expiry = null;
    stream.watchdog = null;
    closeSocket(stream.socket);
    const reason = new Error(this.#stopping ? 'camera is stopping' : 'cancelled');
    this.#answerPrepare(stream, reason);
    this.#answerStart(stream, reason);
    const { child } = stream;
    const exited = child ? stopProcess(child) : Promise.resolve();
    stream.ending = Promise.all([stream.closed, exited]).then(() => {
      if (this.#streams.get(sessionID) === stream) this.#streams.delete(sessionID);
    });
    return stream.ending;
  }

  /** Refuse new work, cancel snapshot renders and end every stream. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#abort.abort();
    await Promise.all([this.#queue, ...[...this.#streams].map(([id, stream]) => this.#end(id, stream))]);
  }
}
