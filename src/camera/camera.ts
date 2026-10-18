import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import {
  Accessory,
  CameraController,
  Characteristic,
  Service,
  uuid,
  type CameraStreamingDelegate,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
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
/** Distinct snapshot sizes kept in memory (least recently used evicted). */
export const SNAPSHOT_CACHE_SIZES = 4;
/** Snapshot renders waiting or running at once; more are refused. */
export const SNAPSHOT_QUEUE_LIMIT = 4;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;

const DEFAULT_STREAM_IDLE_MS = 30_000;
const IDLE_CHECK_MS = 5_000;
/** A prepared stream that is never started gives its port back after this. */
const PREPARED_TTL_MS = 30_000;

interface Pending {
  targetAddress: string;
  ipv6: boolean;
  targetPort: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
  ssrc: number;
  /** Bound to the port we advertised: the receiver's RTCP arrives here. */
  socket: Socket;
  expiry: NodeJS.Timeout;
}

interface Session {
  child: ChildProcess;
  socket: Socket;
  watchdog: NodeJS.Timeout;
  lastRtcp: number | null;
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

/**
 * The camera of one printer: snapshots for the Home tile and live video,
 * both with the status overlay.
 *
 * Snapshots are served stale-while-revalidate (a slow ffmpeg never blocks
 * the bridge), validated, rendered one at a time and cached for a few sizes.
 * Each live stream is one ffmpeg; it ends on STOP, when ffmpeg exits, or
 * when the receiver's RTCP goes quiet.
 */
export class PrinterCamera implements CameraStreamingDelegate {
  readonly accessory: Accessory;
  readonly controller: CameraController;
  readonly #options: PrinterCameraOptions;
  readonly #files: OverlayFiles;
  readonly #filter: string;
  readonly #idleMs: number;
  readonly #pending = new Map<string, Pending>();
  readonly #sessions = new Map<string, Session>();
  readonly #snapshots = new Map<string, CachedSnapshot>();
  readonly #rendering = new Map<string, Promise<Buffer>>();
  readonly #abort = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #stopping = false;

  constructor(options: PrinterCameraOptions) {
    this.#options = options;
    this.#idleMs = options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS;
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

  get activeStreams(): number {
    return this.#sessions.size;
  }

  get cachedSnapshotSizes(): number {
    return this.#snapshots.size;
  }

  /** Push the latest printer state into the overlay (snapshots and live video). */
  update(input: OverlayInput): void {
    this.#files.write(overlayContent(input));
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
      if (Date.now() - cached.at > SNAPSHOT_FRESH_MS) this.#render(width, height).catch(() => {});
      return;
    }
    this.#render(width, height).then(
      (image) => callback(undefined, image),
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
        while (this.#snapshots.size > SNAPSHOT_CACHE_SIZES) this.#snapshots.delete(this.#snapshots.keys().next().value as string);
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

  // --- live video --------------------------------------------------------------

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    if (this.#stopping) return callback(new Error('camera is stopping'));
    const ipv6 = request.addressVersion === 'ipv6';
    const socket = createSocket(ipv6 ? 'udp6' : 'udp4');
    let bound = false;
    // Permanent listener: an 'error' with no listener would crash the process.
    socket.on('error', (error) => {
      closeSocket(socket);
      if (!bound) callback(error);
      else this.#options.log?.warn(`[${this.#options.name}] stream socket error: ${error.message}`);
    });
    socket.bind(0, () => {
      bound = true;
      const ssrc = CameraController.generateSynchronisationSource();
      const expiry = setTimeout(() => this.#dropPending(request.sessionID), PREPARED_TTL_MS);
      this.#pending.set(request.sessionID, {
        targetAddress: request.targetAddress,
        ipv6,
        targetPort: request.video.port,
        srtpKey: request.video.srtp_key,
        srtpSalt: request.video.srtp_salt,
        ssrc,
        socket,
        expiry,
      });
      callback(undefined, {
        video: { port: socket.address().port, ssrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
      });
    });
  }

  #dropPending(sessionID: string): Pending | undefined {
    const pending = this.#pending.get(sessionID);
    if (!pending) return undefined;
    this.#pending.delete(sessionID);
    clearTimeout(pending.expiry);
    return pending;
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === STREAM_START) return this.#start(request.sessionID, request.video, callback);
    if (request.type === STREAM_RECONFIGURE) return callback(); // keeps the running encoder settings
    if (request.type === STREAM_STOP) {
      const pending = this.#dropPending(request.sessionID);
      if (pending) closeSocket(pending.socket);
      void this.#end(request.sessionID).then(() => callback());
      return;
    }
    callback();
  }

  #start(sessionID: string, video: Extract<StreamingRequest, { type: typeof STREAM_START }>['video'], callback: StreamRequestCallback): void {
    const { name, ffmpeg, source } = this.#options;
    const pending = this.#dropPending(sessionID);
    if (!pending) return callback(new Error('stream was not prepared'));
    if (this.#stopping) {
      closeSocket(pending.socket);
      return callback(new Error('camera is stopping'));
    }
    const { socket, expiry: _expiry, ...target } = pending;
    const args = streamArgs(source, this.#filter, ffmpeg, {
      width: video.width,
      height: video.height,
      fps: video.fps,
      bitrate: video.max_bit_rate,
      profile: video.profile,
      payloadType: video.pt,
      mtu: video.mtu,
      ...target,
    });

    const child = spawn(ffmpeg.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let started = false;
    let failed = false;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));

    child.once('spawn', () => {
      started = true;
      const session: Session = {
        child,
        socket,
        lastRtcp: null,
        watchdog: setInterval(() => {
          // Armed only once RTCP has been seen: never end a stream on a guess.
          if (session.lastRtcp !== null && Date.now() - session.lastRtcp > this.#idleMs) {
            this.#options.log?.warn(`[${name}] stream receiver went quiet; ending the stream`);
            this.#endAndTell(sessionID);
          }
        }, Math.min(IDLE_CHECK_MS, this.#idleMs)),
      };
      socket.on('message', () => {
        if (session.lastRtcp === null) this.#options.log?.log(`[${name}] receiving RTCP from the viewer`);
        session.lastRtcp = Date.now();
      });
      this.#sessions.set(sessionID, session);
      this.#options.log?.log(`[${name}] streaming ${video.width}x${video.height}@${video.fps} ${video.max_bit_rate} kbit/s`);
      callback();
    });
    // Permanent listener (a second 'error', e.g. from kill, must not crash).
    child.on('error', (error) => {
      if (started) return; // 'close' handles a running process that fails
      if (failed) return;
      failed = true;
      closeSocket(socket);
      this.#options.log?.warn(`[${name}] stream failed to start: ${error.message}`);
      callback(error);
    });
    child.once('close', (code, signal) => {
      const session = this.#sessions.get(sessionID);
      if (!session || session.child !== child) return; // ended deliberately
      this.#options.log?.warn(`[${name}] stream ended (${signal ?? code}): ${stderr.trim().split('\n').slice(-2).join(' | ')}`);
      this.#endAndTell(sessionID);
    });
  }

  /** End a stream we decided to end, and tell the Home app right away. */
  #endAndTell(sessionID: string): void {
    void this.#end(sessionID); // drops the session at once; the process stops in the background
    this.controller.forceStopStreamingSession(sessionID);
  }

  /** End a stream session; safe to call more than once. */
  async #end(sessionID: string): Promise<void> {
    const session = this.#sessions.get(sessionID);
    if (!session) return;
    this.#sessions.delete(sessionID);
    clearInterval(session.watchdog);
    closeSocket(session.socket);
    await stopProcess(session.child);
  }

  /** Refuse new work, cancel snapshot renders and end every stream. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#abort.abort();
    for (const id of [...this.#pending.keys()]) {
      const pending = this.#dropPending(id);
      if (pending) closeSocket(pending.socket);
    }
    await Promise.all([this.#queue, ...[...this.#sessions.keys()].map((id) => this.#end(id))]);
  }
}
