// Regression tests for camera lifecycle findings (spawn failure, idle
// streams, snapshot bounds, shutdown).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrinterCamera, SNAPSHOT_CACHE_SIZES, SNAPSHOT_QUEUE_LIMIT, type PrinterCameraOptions } from '../src/camera/camera.ts';
import { STREAM_START, STREAM_STOP } from '../src/homekit/hap-constants.ts';

const dir = mkdtempSync(join(tmpdir(), 'bamboozle-lifecycle-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

// A fake ffmpeg: logs start / end with a timestamp, sleeps, prints a tiny JPEG.
const fake = join(dir, 'fake-ffmpeg.sh');
writeFileSync(
  fake,
  '#!/bin/sh\necho "start $$ $(date +%s%N)" >> "$BZ_FAKE_LOG"\nsleep "${BZ_FAKE_SLEEP:-0.2}"\nprintf "\\377\\330\\377\\331"\necho "end $$ $(date +%s%N)" >> "$BZ_FAKE_LOG"\n',
);
chmodSync(fake, 0o755);

let counter = 0;
function camera(overrides: Partial<PrinterCameraOptions> = {}): PrinterCamera {
  counter++;
  return new PrinterCamera({
    name: 'H2C',
    serial: `S${counter}`,
    source: 'lavfi:testsrc2=size=1680x1080:rate=15',
    overlayDir: join(dir, `overlay-${counter}`),
    fonts: { bold: '/fonts/b.otf', medium: '/fonts/m.otf' },
    ffmpeg: { path: 'ffmpeg', encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' },
    ...overrides,
  });
}

function withFakeFfmpeg(sleep: string): { log: string; options: Partial<PrinterCameraOptions> } {
  const log = join(dir, `fake-${counter + 1}.log`);
  process.env['BZ_FAKE_LOG'] = log;
  process.env['BZ_FAKE_SLEEP'] = sleep;
  return { log, options: { ffmpeg: { path: fake, encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' } } };
}

function snapshot(cam: PrinterCamera, width: unknown, height: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    cam.handleSnapshotRequest({ width, height } as never, (error, buffer) => (error || !buffer ? reject(error ?? new Error('no image')) : resolve(buffer))),
  );
}

function intervals(log: string): Array<{ pid: string; start: number; end?: number }> {
  if (!existsSync(log)) return [];
  const runs = new Map<string, { pid: string; start: number; end?: number }>();
  for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
    const [kind, pid, ns] = line.split(' ') as [string, string, string];
    if (kind === 'start') runs.set(pid, { pid, start: Number(BigInt(ns) / 1_000_000n) });
    else if (runs.has(pid)) runs.get(pid)!.end = Number(BigInt(ns) / 1_000_000n);
  }
  return [...runs.values()];
}

// --- streams ---------------------------------------------------------------------

async function prepare(cam: PrinterCamera, sessionID: string, targetPort: number): Promise<number> {
  return new Promise((resolve, reject) =>
    cam.prepareStream(
      {
        sessionID,
        sourceAddress: '127.0.0.1',
        targetAddress: '127.0.0.1',
        addressVersion: 'ipv4',
        video: { port: targetPort, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
        audio: { port: targetPort + 2, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) },
      } as never,
      (error, response) => (error || !response ? reject(error) : resolve((response.video as { port: number }).port)),
    ),
  );
}

function start(cam: PrinterCamera, sessionID: string): Promise<void> {
  return new Promise((resolve, reject) =>
    cam.handleStreamRequest(
      {
        sessionID,
        type: STREAM_START,
        video: { codec: 0, profile: 1, level: 2, packetizationMode: 0, width: 320, height: 180, fps: 15, pt: 99, ssrc: 1, max_bit_rate: 200, rtcp_interval: 0.5, mtu: 1378 },
        audio: {} as never,
      } as never,
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}

function spyForceStop(cam: PrinterCamera): string[] {
  const calls: string[] = [];
  cam.controller.forceStopStreamingSession = (id: string) => void calls.push(id);
  return calls;
}

test('a stream whose ffmpeg cannot be started fails START and holds no session', async () => {
  const cam = camera({ ffmpeg: { path: join(dir, 'no-such-ffmpeg'), encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' } });
  await prepare(cam, 'missing', 40000);
  await assert.rejects(start(cam, 'missing'), /ENOENT/);
  assert.equal(cam.activeStreams, 0);
  await cam.stop();
});

test('a stream ends when the receiver sent RTCP and then went quiet', { skip: !hasFfmpeg && 'ffmpeg not available', timeout: 20_000 }, async () => {
  const { resolveFonts } = await import('../src/camera/fonts.ts');
  const cam = camera({ fonts: resolveFonts(), streamIdleMs: 600 });
  const forced = spyForceStop(cam);
  const sink = createSocket('udp4');
  await new Promise<void>((resolve) => sink.bind(0, '127.0.0.1', () => resolve()));
  try {
    const rtcpPort = await prepare(cam, 'idle', sink.address().port);
    await start(cam, 'idle');
    const viewer = createSocket('udp4');
    for (let i = 0; i < 3; i++) {
      viewer.send(Buffer.from([0x81, 0xc9, 0, 1]), rtcpPort, '127.0.0.1');
      await new Promise((r) => setTimeout(r, 100));
    }
    viewer.close();
    assert.equal(cam.activeStreams, 1);
    const deadline = Date.now() + 5000;
    while (cam.activeStreams > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(cam.activeStreams, 0, 'ended after the receiver went quiet');
    assert.deepEqual(forced, ['idle'], 'the Home app is told');
  } finally {
    sink.close();
    await cam.stop();
  }
});

test('a stream is not ended when no RTCP was ever seen', { skip: !hasFfmpeg && 'ffmpeg not available', timeout: 20_000 }, async () => {
  const { resolveFonts } = await import('../src/camera/fonts.ts');
  const cam = camera({ fonts: resolveFonts(), streamIdleMs: 300 });
  const sink = createSocket('udp4');
  await new Promise<void>((resolve) => sink.bind(0, '127.0.0.1', () => resolve()));
  try {
    await prepare(cam, 'quiet', sink.address().port);
    await start(cam, 'quiet');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(cam.activeStreams, 1);
    await new Promise<void>((resolve) => cam.handleStreamRequest({ sessionID: 'quiet', type: STREAM_STOP } as never, () => resolve()));
    assert.equal(cam.activeStreams, 0);
  } finally {
    sink.close();
    await cam.stop();
  }
});

test('when ffmpeg exits on its own, the session is released and the Home app told', { skip: !hasFfmpeg && 'ffmpeg not available', timeout: 20_000 }, async () => {
  const { resolveFonts } = await import('../src/camera/fonts.ts');
  const cam = camera({ fonts: resolveFonts(), source: 'lavfi:testsrc2=size=1680x1080:rate=15:duration=1' });
  const forced = spyForceStop(cam);
  const sink = createSocket('udp4');
  await new Promise<void>((resolve) => sink.bind(0, '127.0.0.1', () => resolve()));
  try {
    await prepare(cam, 'short', sink.address().port);
    await start(cam, 'short');
    const deadline = Date.now() + 8000;
    while (forced.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(forced, ['short']);
    assert.equal(cam.activeStreams, 0);
  } finally {
    sink.close();
    await cam.stop();
  }
});

// --- snapshots -------------------------------------------------------------------

test('invalid snapshot sizes are refused without starting ffmpeg', async () => {
  const { log, options } = withFakeFfmpeg('0');
  const cam = camera(options);
  for (const [w, h] of [[0, 360], [-640, 360], [640.5, 360], ['640', 360], [640, '360,drawtext=x'], [10_000, 360], [640, 9000]] as const) {
    await assert.rejects(snapshot(cam, w, h), /invalid snapshot size/, `${String(w)}x${String(h)}`);
  }
  assert.equal(intervals(log).length, 0);
  await cam.stop();
});

test('snapshots render one at a time and the cache keeps a few sizes', async () => {
  const { log, options } = withFakeFfmpeg('0.2');
  const cam = camera(options);
  const sizes = [[640, 360], [480, 270], [320, 180]] as const;
  await Promise.all(sizes.map(([w, h]) => snapshot(cam, w, h)));
  const runs = intervals(log).sort((a, b) => a.start - b.start);
  assert.equal(runs.length, 3);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i]!.start >= runs[i - 1]!.end!, 'no overlap between renders');

  for (const [w, h] of [[1280, 720], [1920, 1080], [960, 540], [800, 450]] as const) await snapshot(cam, w, h);
  assert.ok(cam.cachedSnapshotSizes <= SNAPSHOT_CACHE_SIZES, `cache holds ${cam.cachedSnapshotSizes} sizes`);
  await cam.stop();
});

test('too many distinct snapshot requests at once are refused, not queued forever', async () => {
  const { options } = withFakeFfmpeg('0.2');
  const cam = camera(options);
  const results = await Promise.allSettled(
    Array.from({ length: SNAPSHOT_QUEUE_LIMIT + 3 }, (_, i) => snapshot(cam, 320 + i * 16, 180 + i * 9)),
  );
  const refused = results.filter((r) => r.status === 'rejected' && /too many/.test(String(r.reason)));
  assert.equal(refused.length, 3);
  await cam.stop();
});

test('stop cancels a running snapshot render and refuses new work', async () => {
  const { log, options } = withFakeFfmpeg('5');
  const cam = camera(options);
  const pending = snapshot(cam, 640, 360);
  await new Promise((r) => setTimeout(r, 300));
  const began = Date.now();
  await cam.stop();
  assert.ok(Date.now() - began < 2000, 'stop does not wait for the slow render');
  await assert.rejects(pending);
  await assert.rejects(snapshot(cam, 640, 360), /stopping/);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(intervals(log).every((run) => run.end === undefined), 'the render was killed before finishing');
});
