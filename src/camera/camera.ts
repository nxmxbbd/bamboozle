import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
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

interface Pending {
  targetAddress: string;
  ipv6: boolean;
  targetPort: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
  ssrc: number;
}

interface CachedSnapshot {
  image: Buffer;
  at: number;
}

/** Reserve a free local UDP port for the stream's RTP endpoint. */
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

/**
 * The camera of one printer: snapshots for the Home tile and live video,
 * both with the status overlay. Snapshots are served stale-while-revalidate,
 * so a slow ffmpeg never blocks the bridge.
 */
export class PrinterCamera implements CameraStreamingDelegate {
  readonly accessory: Accessory;
  readonly controller: CameraController;
  readonly #options: PrinterCameraOptions;
  readonly #files: OverlayFiles;
  readonly #filter: string;
  readonly #pending = new Map<string, Pending>();
  readonly #sessions = new Map<string, ChildProcess>();
  readonly #snapshots = new Map<string, CachedSnapshot>();
  readonly #rendering = new Map<string, Promise<Buffer>>();

  constructor(options: PrinterCameraOptions) {
    this.#options = options;
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

  /** Push the latest printer state into the overlay (snapshots and live video). */
  update(input: OverlayInput): void {
    this.#files.write(overlayContent(input));
  }

  // --- snapshots -------------------------------------------------------------

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const key = `${request.width}x${request.height}`;
    const cached = this.#snapshots.get(key);
    if (cached) {
      callback(undefined, cached.image);
      if (Date.now() - cached.at > SNAPSHOT_FRESH_MS) this.#render(request.width, request.height).catch(() => {});
      return;
    }
    this.#render(request.width, request.height).then(
      (image) => callback(undefined, image),
      (error: Error) => {
        this.#options.log?.warn(`[${this.#options.name}] snapshot failed: ${error.message}`);
        callback(error);
      },
    );
  }

  /** Render a snapshot, sharing one ffmpeg run between concurrent requests. */
  #render(width: number, height: number): Promise<Buffer> {
    const key = `${width}x${height}`;
    const running = this.#rendering.get(key);
    if (running) return running;
    const { ffmpeg, source } = this.#options;
    const job = runForOutput(ffmpeg.path, snapshotArgs(source, this.#filter, width, height), SNAPSHOT_TIMEOUT_MS)
      .then((image) => {
        this.#snapshots.set(key, { image, at: Date.now() });
        return image;
      })
      .finally(() => this.#rendering.delete(key));
    this.#rendering.set(key, job);
    return job;
  }

  // --- live video --------------------------------------------------------------

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    freeUdpPort().then(
      (localPort) => {
        const ssrc = CameraController.generateSynchronisationSource();
        this.#pending.set(request.sessionID, {
          targetAddress: request.targetAddress,
          ipv6: request.addressVersion === 'ipv6',
          targetPort: request.video.port,
          srtpKey: request.video.srtp_key,
          srtpSalt: request.video.srtp_salt,
          ssrc,
        });
        callback(undefined, { video: { port: localPort, ssrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt } });
      },
      (error: Error) => callback(error),
    );
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const { name, ffmpeg, source } = this.#options;
    if (request.type === STREAM_START) {
      const pending = this.#pending.get(request.sessionID);
      this.#pending.delete(request.sessionID);
      if (!pending) return callback(new Error('stream was not prepared'));
      const { video } = request;
      const args = streamArgs(source, this.#filter, ffmpeg, {
        width: video.width,
        height: video.height,
        fps: video.fps,
        bitrate: video.max_bit_rate,
        profile: video.profile,
        payloadType: video.pt,
        mtu: video.mtu,
        ...pending,
      });
      const child = spawn(ffmpeg.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
      child.on('error', (error) => this.#options.log?.warn(`[${name}] stream failed to start: ${error.message}`));
      child.on('exit', (code, signal) => {
        if (this.#sessions.get(request.sessionID) !== child) return;
        this.#sessions.delete(request.sessionID);
        // Exited on its own (source gone, encoder error): tell the Home app.
        this.#options.log?.warn(`[${name}] stream ended (${signal ?? code}): ${stderr.trim().split('\n').slice(-2).join(' | ')}`);
        this.controller.forceStopStreamingSession(request.sessionID);
      });
      this.#sessions.set(request.sessionID, child);
      this.#options.log?.log(`[${name}] streaming ${video.width}x${video.height}@${video.fps} ${video.max_bit_rate} kbit/s`);
      return callback();
    }
    if (request.type === STREAM_RECONFIGURE) return callback();
    if (request.type === STREAM_STOP) {
      this.#pending.delete(request.sessionID);
      const child = this.#sessions.get(request.sessionID);
      this.#sessions.delete(request.sessionID);
      if (!child) return callback();
      void stopProcess(child).then(() => callback());
      return;
    }
    callback();
  }

  async stop(): Promise<void> {
    const children = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(children.map((child) => stopProcess(child)));
  }
}
