import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrinterCamera } from '../src/camera/camera.ts';
import { snapshotArgs, sourceArgs, srtpParams, streamArgs, type FfmpegSettings, type StreamSpec } from '../src/camera/ffmpeg.ts';
import { STREAM_START, STREAM_STOP } from '../src/homekit/hap-constants.ts';
import { parseStatus } from '../src/printer/status.ts';
import type { JsonObject } from '../src/printer/merge.ts';

const LIBX264: FfmpegSettings = { path: 'ffmpeg', encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' };
const SPEC: StreamSpec = {
  width: 1280, height: 720, fps: 30, bitrate: 299, profile: 1, payloadType: 99, ssrc: 12345678, mtu: 1378,
  targetAddress: '10.0.0.2', ipv6: false, targetPort: 52000,
  srtpKey: Buffer.alloc(16, 1), srtpSalt: Buffer.alloc(14, 2),
};

test('source arguments', () => {
  assert.deepEqual(sourceArgs('lavfi:testsrc2'), ['-f', 'lavfi', '-i', 'testsrc2']);
  assert.deepEqual(sourceArgs('rtsp://127.0.0.1:8554/h2c'), ['-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:8554/h2c']);
  assert.deepEqual(sourceArgs('rtsp://x/y', { keyframesOnly: true }).slice(0, 2), ['-skip_frame', 'nokey']);
  assert.deepEqual(sourceArgs('/tmp/still.png'), ['-i', '/tmp/still.png']);
});

test('snapshot arguments: one keyframe, overlaid, scaled, JPEG on stdout', () => {
  const args = snapshotArgs('rtsp://127.0.0.1:8554/h2c', 'OVERLAY', 640, 360);
  assert.ok(args.includes('-skip_frame'));
  assert.equal(args[args.indexOf('-filter_complex') + 1], '[0:v]OVERLAY,scale=640:360[out]');
  assert.deepEqual(args.slice(-7), ['-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', 'pipe:1']);
});

test('stream arguments: libx264 over SRTP with the negotiated parameters', () => {
  const args = streamArgs('rtsp://127.0.0.1:8554/h2c', 'OVERLAY', LIBX264, SPEC);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at('-c:v'), 'libx264');
  assert.equal(at('-profile:v'), 'main');
  assert.equal(at('-b:v'), '299k');
  assert.equal(at('-payload_type'), '99');
  assert.equal(at('-ssrc'), '12345678');
  assert.equal(at('-srtp_out_suite'), 'AES_CM_128_HMAC_SHA1_80');
  assert.equal(at('-srtp_out_params'), Buffer.concat([SPEC.srtpKey, SPEC.srtpSalt]).toString('base64'));
  assert.equal(at('-filter_complex'), '[0:v]OVERLAY,fps=30,scale=1280:720,format=yuv420p[out]');
  assert.equal(args.at(-1), 'srtp://10.0.0.2:52000?rtcpport=52000&pkt_size=1378');
  assert.ok(args.includes('-an'));
  assert.ok(!args.includes('-vaapi_device'));
});

test('stream arguments: vaapi, baseline, IPv6 target', () => {
  const args = streamArgs('rtsp://x/y', 'OVERLAY', { ...LIBX264, encoder: 'vaapi' }, { ...SPEC, profile: 0, ipv6: true, targetAddress: 'fe80::1' });
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at('-vaapi_device'), '/dev/dri/renderD128');
  assert.ok(args.indexOf('-vaapi_device') < args.indexOf('-i'), 'device before the input');
  assert.equal(at('-c:v'), 'h264_vaapi');
  assert.equal(at('-profile:v'), 'constrained_baseline');
  assert.equal(at('-bf'), '0');
  assert.ok(at('-filter_complex')?.endsWith(',format=nv12,hwupload[out]'));
  assert.ok(args.at(-1)?.startsWith('srtp://[fe80::1]:52000?'));
});

test('srtp params are key then salt, base64', () => {
  assert.equal(srtpParams(Buffer.from([1, 2]), Buffer.from([3])), Buffer.from([1, 2, 3]).toString('base64'));
});

// --- with ffmpeg ---------------------------------------------------------------

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'bamboozle-camera-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function camera(name: string): Promise<PrinterCamera> {
  const { resolveFonts } = await import('../src/camera/fonts.ts');
  const cam = new PrinterCamera({
    name: 'H2C',
    serial: 'SERIAL1',
    source: 'lavfi:testsrc2=size=1680x1080:rate=15',
    overlayDir: join(dir, name),
    fonts: resolveFonts(),
    ffmpeg: LIBX264,
  });
  const status = parseStatus(JSON.parse(readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8')) as JsonObject);
  cam.update({ status, available: true, name: 'H2C', now: new Date(), finishedAt: null });
  return cam;
}

function snapshot(cam: PrinterCamera, width: number, height: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    cam.handleSnapshotRequest({ width, height }, (error, buffer) => (error || !buffer ? reject(error ?? new Error('no image')) : resolve(buffer))),
  );
}

test('snapshot: a JPEG of the requested size, then served from cache', { skip: !hasFfmpeg && 'ffmpeg not available' }, async () => {
  const cam = await camera('snapshot');
  const first = await snapshot(cam, 640, 360);
  assert.equal(first.subarray(0, 2).toString('hex'), 'ffd8', 'JPEG start of image');
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: first }).toString().trim();
  assert.equal(probe, '640,360');
  const started = Date.now();
  const second = await snapshot(cam, 640, 360);
  assert.ok(Date.now() - started < 50, 'cached snapshot returns immediately');
  assert.equal(second, first);
});

test('live stream: SRTP packets with our payload type and SSRC reach the target, and stop', { skip: !hasFfmpeg && 'ffmpeg not available', timeout: 30_000 }, async () => {
  const cam = await camera('stream');
  const socket = createSocket('udp4');
  const packets: Buffer[] = [];
  socket.on('message', (message) => packets.push(message));
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
  const targetPort = socket.address().port;
  const sessionID = 'session-1';
  try {
    const prepared = await new Promise<{ ssrc: number }>((resolve, reject) =>
      cam.prepareStream(
        {
          sessionID,
          sourceAddress: '127.0.0.1',
          targetAddress: '127.0.0.1',
          addressVersion: 'ipv4',
          video: { port: targetPort, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 7), srtp_salt: Buffer.alloc(14, 9) },
          audio: { port: targetPort + 2, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 7), srtp_salt: Buffer.alloc(14, 9) },
        } as never,
        (error, response) => (error || !response ? reject(error) : resolve(response.video as { ssrc: number })),
      ),
    );
    await new Promise<void>((resolve, reject) =>
      cam.handleStreamRequest(
        {
          sessionID,
          type: STREAM_START,
          video: { codec: 0, profile: 1, level: 2, packetizationMode: 0, width: 640, height: 360, fps: 15, pt: 99, ssrc: 1, max_bit_rate: 300, rtcp_interval: 0.5, mtu: 1378 },
          audio: {} as never,
        } as never,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    assert.equal(cam.activeStreams, 1);
    const deadline = Date.now() + 15_000;
    while (packets.length < 20 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(packets.length >= 20, `received ${packets.length} packets`);
    const rtp = packets.find((p) => (p[1]! & 0x7f) === 99);
    assert.ok(rtp, 'an RTP packet with payload type 99');
    assert.equal(rtp[0]! >> 6, 2, 'RTP version 2');
    assert.equal(rtp.readUInt32BE(8), prepared.ssrc >>> 0, 'our SSRC');
    await new Promise<void>((resolve) => cam.handleStreamRequest({ sessionID, type: STREAM_STOP } as never, () => resolve()));
    assert.equal(cam.activeStreams, 0);
    const count = packets.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(packets.length - count <= 2, 'no more packets after stop');
  } finally {
    socket.close();
    await cam.stop();
  }
});
