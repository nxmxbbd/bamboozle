import { spawn, type ChildProcess } from 'node:child_process';

export type Encoder = 'libx264' | 'vaapi';

export interface FfmpegSettings {
  /** ffmpeg binary. */
  path: string;
  encoder: Encoder;
  /** Render node for the vaapi encoder. */
  vaapiDevice: string;
}

/**
 * Input arguments for a camera source: rtsp(s):// URLs, any other ffmpeg URL
 * or file, or `lavfi:<graph>` for a generated test picture.
 */
export function sourceArgs(source: string, options: { keyframesOnly?: boolean } = {}): string[] {
  if (source.startsWith('lavfi:')) return ['-f', 'lavfi', '-i', source.slice('lavfi:'.length)];
  const skip = options.keyframesOnly ? ['-skip_frame', 'nokey'] : [];
  if (/^rtsps?:\/\//i.test(source)) return [...skip, '-rtsp_transport', 'tcp', '-i', source];
  return [...skip, '-i', source];
}

/** One overlaid JPEG frame at the requested size, on stdout. */
export function snapshotArgs(source: string, overlay: string, width: number, height: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    // A decoder joining mid-GOP produces smeared frames; wait for a keyframe.
    ...sourceArgs(source, { keyframesOnly: true }),
    '-frames:v', '1', '-update', '1',
    '-filter_complex', `[0:v]${overlay},scale=${width}:${height}[out]`, '-map', '[out]',
    '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', 'pipe:1',
  ];
}

export interface StreamSpec {
  width: number;
  height: number;
  fps: number;
  /** kbit/s, as negotiated by the Home app. */
  bitrate: number;
  /** HomeKit profile index: 0 baseline, 1 main, 2 high. */
  profile: number;
  payloadType: number;
  ssrc: number;
  mtu: number;
  targetAddress: string;
  ipv6: boolean;
  targetPort: number;
  srtpKey: Buffer;
  srtpSalt: Buffer;
}

const PROFILES = ['baseline', 'main', 'high'] as const;

export function srtpParams(key: Buffer, salt: Buffer): string {
  return Buffer.concat([key, salt]).toString('base64');
}

/** Overlaid H.264 over SRTP to the Home app, the way HomeKit cameras stream. */
export function streamArgs(source: string, overlay: string, settings: FfmpegSettings, spec: StreamSpec): string[] {
  const profile = PROFILES[spec.profile] ?? 'main';
  const vaapi = settings.encoder === 'vaapi';
  const encoder = vaapi
    ? ['-c:v', 'h264_vaapi', '-profile:v', profile === 'baseline' ? 'constrained_baseline' : profile, '-bf', '0']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', profile, '-pix_fmt', 'yuv420p'];
  const tail = vaapi ? ',format=nv12,hwupload' : ',format=yuv420p';
  const host = spec.ipv6 ? `[${spec.targetAddress}]` : spec.targetAddress;
  return [
    '-hide_banner', '-loglevel', 'error',
    ...(vaapi ? ['-vaapi_device', settings.vaapiDevice] : []),
    ...sourceArgs(source),
    '-an', '-sn', '-dn',
    '-filter_complex', `[0:v]${overlay},fps=${spec.fps},scale=${spec.width}:${spec.height}${tail}[out]`,
    '-map', '[out]',
    ...encoder,
    '-g', String(spec.fps * 2),
    '-b:v', `${spec.bitrate}k`, '-maxrate', `${spec.bitrate}k`, '-bufsize', `${spec.bitrate * 2}k`,
    '-payload_type', String(spec.payloadType),
    '-ssrc', String(spec.ssrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', srtpParams(spec.srtpKey, spec.srtpSalt),
    `srtp://${host}:${spec.targetPort}?rtcpport=${spec.targetPort}&pkt_size=${spec.mtu}`,
  ];
}

/** Run ffmpeg and collect stdout, failing after `timeoutMs`. */
export function runForOutput(ffmpeg: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buffer = Buffer.concat(out);
      if (code === 0 && buffer.length > 0) resolve(buffer);
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** Stop a long-running ffmpeg: SIGTERM, then SIGKILL if it lingers. */
export function stopProcess(child: ChildProcess, graceMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
