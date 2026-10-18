// Regression tests for camera lifecycle findings (spawn failure, idle
// streams, STOP / stop() racing setup, socket errors, RTCP filtering,
// snapshot bounds, shutdown).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function startRequest(sessionID: string): never {
  return {
    sessionID,
    type: STREAM_START,
    video: { codec: 0, profile: 1, level: 2, packetizationMode: 0, width: 320, height: 180, fps: 15, pt: 99, ssrc: 1, max_bit_rate: 200, rtcp_interval: 0.5, mtu: 1378 },
    audio: {} as never,
  } as never;
}

function start(cam: PrinterCamera, sessionID: string): Promise<void> {
  return new Promise((resolve, reject) => cam.handleStreamRequest(startRequest(sessionID), (error) => (error ? reject(error) : resolve())));
}

function stopStream(cam: PrinterCamera, sessionID: string): Promise<void> {
  return new Promise((resolve) => cam.handleStreamRequest({ sessionID, type: STREAM_STOP } as never, () => resolve()));
}

function spyForceStop(cam: PrinterCamera): string[] {
  const calls: string[] = [];
  cam.controller.forceStopStreamingSession = (id: string) => void calls.push(id);
  return calls;
}

/** A receiver report header: version 2, one report block, packet type 201, length 1. */
const RTCP_RR = Buffer.from([0x81, 0xc9, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]);

// A fake stream encoder: runs until it is signalled (exec, so the signal
// reaches the process itself and nothing outlives it).
const fakeStream = join(dir, 'fake-stream.sh');
writeFileSync(fakeStream, '#!/bin/sh\nexec sleep 30\n');
chmodSync(fakeStream, 0o755);
const FAKE_STREAM: Partial<PrinterCameraOptions> = { ffmpeg: { path: fakeStream, encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' } };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await delay(25);
}

/** Our own child processes that have not been reaped (Linux /proc; empty elsewhere). */
function liveChildren(): number[] {
  if (!existsSync('/proc/self/task')) return [];
  const pids: number[] = [];
  for (const task of readdirSync('/proc/self/task')) {
    try {
      pids.push(...readFileSync(`/proc/self/task/${task}/children`, 'utf8').split(' ').filter(Boolean).map(Number));
    } catch {
      // the thread is gone
    }
  }
  return pids;
}

/** Child processes started since `before` was taken and still not reaped. */
function newChildren(before: number[]): number[] {
  return liveChildren().filter((pid) => !before.includes(pid));
}

/** Whether a UDP port (on all interfaces, as the camera binds) can be bound right now. */
async function portIsFree(port: number): Promise<boolean> {
  const probe = createSocket('udp4');
  const free = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false));
    probe.bind(port, () => resolve(true));
  });
  try {
    probe.close();
  } catch {
    // never bound
  }
  return free;
}

async function boundTo(address: string): Promise<Socket | null> {
  const socket = createSocket('udp4');
  return new Promise((resolve) => {
    socket.once('error', () => resolve(null));
    socket.bind(0, address, () => resolve(socket));
  });
}

test('a stream whose ffmpeg cannot be started fails START and holds no session', async () => {
  const cam = camera({ ffmpeg: { path: join(dir, 'no-such-ffmpeg'), encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' } });
  await prepare(cam, 'missing', 40000);
  await assert.rejects(start(cam, 'missing'), /ENOENT/);
  assert.equal(cam.activeStreams, 0);
  assert.equal(cam.trackedStreams, 0);
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
      viewer.send(RTCP_RR, rtcpPort, '127.0.0.1');
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

test('a prepared stream that is never started closes its socket and gives the port back', async () => {
  const cam = camera({ preparedTtlMs: 150 });
  try {
    const port = await prepare(cam, 'expire', 40000);
    assert.equal(await portIsFree(port), false, 'the advertised port is held while prepared');
    await delay(500);
    assert.equal(await portIsFree(port), true, 'the port can be bound again after expiry');
    assert.equal(cam.trackedStreams, 0);
    await assert.rejects(start(cam, 'expire'), /not prepared/);
  } finally {
    await cam.stop();
  }
});

// HAP-NodeJS keeps a prepared session's slot in use until STOP, a failed
// request, forceStopStreamingSession or the controller disconnecting.
test('a prepared stream that expires frees its session in the Home app', async () => {
  const cam = camera({ preparedTtlMs: 150 });
  const forced = spyForceStop(cam);
  try {
    await prepare(cam, 'expire-tell', 40000);
    await delay(500);
    assert.equal(cam.trackedStreams, 0);
    assert.deepEqual(forced, ['expire-tell']);
  } finally {
    await cam.stop();
  }
});

test('a socket error on a prepared stream ends it, frees the port and tells the Home app', async () => {
  const sockets = new Map<string, Socket>();
  const cam = camera({ onStreamSocket: (id, socket) => void sockets.set(id, socket) });
  const forced = spyForceStop(cam);
  try {
    const port = await prepare(cam, 'prepared-error', 40000);
    sockets.get('prepared-error')!.emit('error', new Error('simulated socket failure'));
    assert.deepEqual(forced, ['prepared-error'], 'the Home app is told at once');
    await waitFor(() => cam.trackedStreams === 0, 2000);
    assert.equal(cam.trackedStreams, 0);
    assert.equal(await portIsFree(port), true);
    await assert.rejects(start(cam, 'prepared-error'), /not prepared/);
  } finally {
    await cam.stop();
  }
});

// HAP-NodeJS answers characteristic writes from promise callbacks, so STOP
// arrives in a microtask, where an answer could run before the socket's
// 'close' (a next-tick event).
test('STOP is answered only after the stream socket has closed', async () => {
  const sockets: Socket[] = [];
  const cam = camera({ onStreamSocket: (_id, socket) => void sockets.push(socket) });
  try {
    await prepare(cam, 'close-order', 40000);
    let closed = false;
    sockets[0]!.once('close', () => (closed = true));
    await Promise.resolve();
    const closedWhenAnswered = await new Promise<boolean>((resolve) =>
      cam.handleStreamRequest({ sessionID: 'close-order', type: STREAM_STOP } as never, () => resolve(closed)),
    );
    assert.equal(closedWhenAnswered, true);
  } finally {
    await cam.stop();
  }
});

test('stop() resolves only after a binding stream socket has closed', async () => {
  const sockets: Socket[] = [];
  let closed = false;
  const cam = camera({ onStreamSocket: (_id, socket) => void (sockets.push(socket), socket.once('close', () => (closed = true))) });
  const prepared = prepare(cam, 'close-binding', 40000).catch(() => {});
  await Promise.resolve();
  await cam.stop();
  assert.equal(closed, true);
  await prepared;
});

test('STOP of a prepared stream frees it without telling the Home app, which asked', async () => {
  const cam = camera();
  const forced = spyForceStop(cam);
  try {
    const port = await prepare(cam, 'prepared-stop', 40000);
    await stopStream(cam, 'prepared-stop');
    assert.equal(cam.trackedStreams, 0);
    assert.equal(await portIsFree(port), true);
    assert.deepEqual(forced, []);
  } finally {
    await cam.stop();
  }
});

test('stop() while the stream socket is binding fails the prepare and leaves nothing behind', async () => {
  const sockets: Socket[] = [];
  const cam = camera({ onStreamSocket: (_id, socket) => void sockets.push(socket) });
  const prepared = prepare(cam, 'binding', 40000);
  await cam.stop();
  await assert.rejects(prepared, /stopping/);
  await delay(100); // a bind completing late must not bring it back
  assert.equal(cam.trackedStreams, 0);
  assert.equal(sockets.length, 1);
  assert.throws(() => sockets[0]!.address(), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }, 'the socket is closed');
});

test('STOP right after START ends the stream; the encoder does not outlive it', async () => {
  const cam = camera(FAKE_STREAM);
  const forced = spyForceStop(cam);
  const before = liveChildren();
  try {
    const port = await prepare(cam, 'stop-start', 40000);
    const started = assert.rejects(start(cam, 'stop-start'), /cancelled/);
    await stopStream(cam, 'stop-start');
    assert.deepEqual(newChildren(before), [], 'the encoder has exited when STOP is answered');
    await started;
    await delay(200); // a late 'spawn' must not bring it back
    assert.equal(cam.activeStreams, 0);
    assert.equal(cam.trackedStreams, 0);
    assert.equal(await portIsFree(port), true);
    assert.deepEqual(forced, [], 'the Home app asked; no need to tell it');
  } finally {
    await cam.stop();
  }
});

test('stop() right after START ends the stream; the encoder does not outlive it', async () => {
  const cam = camera(FAKE_STREAM);
  const before = liveChildren();
  try {
    const port = await prepare(cam, 'stop-during-start', 40000);
    const started = assert.rejects(start(cam, 'stop-during-start'), /stopping/);
    await cam.stop();
    assert.deepEqual(newChildren(before), [], 'the encoder has exited when stop() resolves');
    await started;
    await delay(200);
    assert.equal(cam.activeStreams, 0);
    assert.equal(cam.trackedStreams, 0);
    assert.equal(await portIsFree(port), true);
  } finally {
    await cam.stop();
  }
});

test('STOP right after a START whose ffmpeg is missing answers both and leaves nothing behind', { timeout: 5000 }, async () => {
  const cam = camera({ ffmpeg: { path: join(dir, 'no-such-ffmpeg'), encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' } });
  try {
    const port = await prepare(cam, 'missing-stop', 40000);
    const started = assert.rejects(start(cam, 'missing-stop'));
    // The child never started: ending it must not signal it or wait for an exit that never comes.
    await stopStream(cam, 'missing-stop');
    await started;
    assert.equal(cam.trackedStreams, 0);
    assert.equal(await portIsFree(port), true);
  } finally {
    await cam.stop();
  }
});

test('a spawn that throws fails START and releases the port', async () => {
  const cam = camera({ ffmpeg: { path: join(dir, 'ff\u0000mpeg'), encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' } });
  try {
    const port = await prepare(cam, 'nul', 40000);
    const answers: Array<Error | undefined> = [];
    assert.doesNotThrow(() => cam.handleStreamRequest(startRequest('nul'), (error) => void answers.push(error)));
    assert.equal(answers.length, 1);
    assert.match(String(answers[0]?.message), /null bytes/);
    assert.equal(await portIsFree(port), true, 'the socket is closed');
    assert.equal(cam.activeStreams, 0);
    assert.equal(cam.trackedStreams, 0);
  } finally {
    await cam.stop();
  }
});

test('a socket error on a running stream ends it, stops the encoder and tells the Home app', async () => {
  const sockets = new Map<string, Socket>();
  const cam = camera({ ...FAKE_STREAM, onStreamSocket: (id, socket) => void sockets.set(id, socket) });
  const forced = spyForceStop(cam);
  const before = liveChildren();
  try {
    await prepare(cam, 'socket-error', 40000);
    await start(cam, 'socket-error');
    assert.equal(cam.activeStreams, 1);
    assert.equal(newChildren(before).length, 1, 'the encoder runs');
    const socket = sockets.get('socket-error');
    assert.ok(socket, 'the test seam saw the stream socket');
    socket.emit('error', new Error('simulated socket failure'));
    assert.equal(cam.activeStreams, 0);
    assert.deepEqual(forced, ['socket-error'], 'the Home app is told at once');
    await waitFor(() => cam.trackedStreams === 0, 5000);
    assert.equal(cam.trackedStreams, 0);
    assert.deepEqual(newChildren(before), [], 'the encoder is stopped');
  } finally {
    await cam.stop();
  }
});

/** Send `packets` from `from` to the camera's port, a few times, then wait out the idle time. */
async function sendThenWait(from: Socket, port: number, packets: Buffer[]): Promise<void> {
  for (let i = 0; i < 4; i++) {
    for (const packet of packets) from.send(packet, port, '127.0.0.1');
    await delay(100);
  }
  await delay(1200); // idle 300 ms, checked every 300 ms
}

test('RTCP from another address does not arm the idle check; RTCP from the viewer does', async (t) => {
  const stranger = await boundTo('127.0.0.2');
  if (!stranger) return t.skip('127.0.0.2 cannot be bound here');
  const viewer = (await boundTo('127.0.0.1'))!;
  const cam = camera({ ...FAKE_STREAM, streamIdleMs: 300 });
  const forced = spyForceStop(cam);
  try {
    const port = await prepare(cam, 'stranger', 40000);
    await start(cam, 'stranger');
    await sendThenWait(stranger, port, [RTCP_RR]);
    assert.equal(cam.activeStreams, 1, 'RTCP from 127.0.0.2 is not the viewer at 127.0.0.1');
    assert.deepEqual(forced, []);
    await sendThenWait(viewer, port, [RTCP_RR]);
    assert.equal(cam.activeStreams, 0, 'armed by the viewer, then ended when it went quiet');
    assert.deepEqual(forced, ['stranger']);
  } finally {
    stranger.close();
    viewer.close();
    await cam.stop();
  }
});

test('packets from the viewer that are not RTCP do not arm the idle check', async () => {
  const viewer = (await boundTo('127.0.0.1'))!;
  const cam = camera({ ...FAKE_STREAM, streamIdleMs: 300 });
  const forced = spyForceStop(cam);
  const malformed = [
    RTCP_RR.subarray(0, 4), // too short
    Buffer.from([0x41, 0xc9, 0x00, 0x01, 0, 0, 0, 1]), // version 1
    Buffer.from([0x80, 0x60, 0x00, 0x01, 0, 0, 0, 1]), // RTP, payload type 96
    Buffer.from([0x81, 0xc7, 0x00, 0x01, 0, 0, 0, 1]), // packet type 199
    Buffer.from([0x81, 0xcf, 0x00, 0x01, 0, 0, 0, 1]), // packet type 207
    Buffer.from('not a packet at all'),
  ];
  try {
    const port = await prepare(cam, 'malformed', 40000);
    await start(cam, 'malformed');
    await sendThenWait(viewer, port, malformed);
    assert.equal(cam.activeStreams, 1, 'malformed packets are not viewer activity');
    assert.deepEqual(forced, []);
    await sendThenWait(viewer, port, [RTCP_RR]);
    assert.equal(cam.activeStreams, 0, 'a valid RTCP header arms it');
    assert.deepEqual(forced, ['malformed']);
  } finally {
    viewer.close();
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
