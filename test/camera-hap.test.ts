// The camera against HAP-NodeJS's own stream management instead of a
// stand-in: each session is set up through the real SetupEndpoints handler,
// so the assertions are about HAP-NodeJS's session slot itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode, uuid } from 'hap-nodejs';
import { PrinterCamera, type PrinterCameraOptions } from '../src/camera/camera.ts';

const dir = mkdtempSync(join(tmpdir(), 'bamboozle-hap-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function camera(overrides: Partial<PrinterCameraOptions> = {}): PrinterCamera {
  counter++;
  return new PrinterCamera({
    name: 'H2C',
    serial: `HAP${counter}`,
    source: 'lavfi:testsrc2=size=1680x1080:rate=15',
    overlayDir: join(dir, `overlay-${counter}`),
    fonts: { bold: '/fonts/b.otf', medium: '/fonts/m.otf' },
    ffmpeg: { path: 'ffmpeg', encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' },
    ...overrides,
  });
}

/** StreamingStatus values of the stream management service. */
const AVAILABLE = 0;
const IN_USE = 1;

/** The parts of HAP-NodeJS's RTPStreamManagement these tests use. */
interface StreamManagement {
  streamStatus: number;
  sessionIdentifier?: string;
  handleSetupEndpoints(value: string, callback: (error?: unknown) => void, connection: unknown): void;
}

/** Enough of a HAP connection for SetupEndpoints; 'closed' is what a disconnect emits. */
class FakeConnection extends EventEmitter {
  readonly sessionID = randomUUID();
  readonly localAddress = '127.0.0.1';
  getLocalAddress(): string {
    return '127.0.0.1';
  }
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

/** A SetupEndpoints write as the Home app sends it (IPv4, AES_CM_128_HMAC_SHA1_80). */
function setupEndpoints(sessionID: string, videoPort: number): string {
  const srtp = encode(1, 0, 2, Buffer.alloc(16, 1), 3, Buffer.alloc(14, 2));
  return encode(
    1, uuid.write(sessionID),
    3, encode(1, 0, 2, '127.0.0.1', 3, uint16(videoPort), 4, uint16(videoPort + 2)),
    4, srtp,
    5, srtp,
  ).toString('base64');
}

async function setUp(cam: PrinterCamera, sessionID: string): Promise<{ management: StreamManagement; connection: FakeConnection }> {
  const management = cam.controller.streamManagements[0] as unknown as StreamManagement;
  const connection = new FakeConnection();
  const error = await new Promise((resolve) => management.handleSetupEndpoints(setupEndpoints(sessionID, 40000), resolve, connection));
  assert.equal(error ?? undefined, undefined, 'SetupEndpoints succeeded');
  assert.equal(management.streamStatus, IN_USE, 'HAP-NodeJS holds the slot');
  assert.equal(management.sessionIdentifier, sessionID);
  assert.equal(cam.trackedStreams, 1);
  return { management, connection };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('HAP: a prepared stream that expires gives HAP-NodeJS its slot back', async () => {
  const cam = camera({ preparedTtlMs: 150 });
  try {
    const { management } = await setUp(cam, randomUUID());
    await delay(500);
    assert.equal(cam.trackedStreams, 0);
    assert.equal(management.streamStatus, AVAILABLE);
    assert.equal(management.sessionIdentifier, undefined);
  } finally {
    await cam.stop();
  }
});

test('HAP: a socket error on a prepared stream gives HAP-NodeJS its slot back', async () => {
  const sockets: Socket[] = [];
  const cam = camera({ onStreamSocket: (_id, socket) => void sockets.push(socket) });
  try {
    const { management } = await setUp(cam, randomUUID());
    sockets[0]!.emit('error', new Error('simulated socket failure'));
    assert.equal(management.streamStatus, AVAILABLE);
    assert.equal(management.sessionIdentifier, undefined);
    await delay(50);
    assert.equal(cam.trackedStreams, 0);
  } finally {
    await cam.stop();
  }
});

// Preservation: HAP-NodeJS turns a disconnect into STOP on its own.
test('HAP: the controller disconnecting ends a prepared stream and frees the slot', async () => {
  const cam = camera();
  try {
    const { management, connection } = await setUp(cam, randomUUID());
    connection.emit('closed');
    assert.equal(management.streamStatus, AVAILABLE);
    await delay(50);
    assert.equal(cam.trackedStreams, 0);
  } finally {
    await cam.stop();
  }
});
