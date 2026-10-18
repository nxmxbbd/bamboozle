// Regression tests for the 2026-10 full review findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, parseConfig } from '../src/config.ts';
import { ReportAccumulator } from '../src/printer/accumulator.ts';
import { PrinterClient, type MqttFactory } from '../src/printer/client.ts';
import { parseStatus } from '../src/printer/status.ts';
import { overlayContent } from '../src/camera/overlay.ts';

const SECRET = 'DUMMY123';

test('malformed config JSON never quotes the file (the access code) in the error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bamboozle-cfg-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, `{\n  "printers": [\n    {"name": "H2C", "accessCode": ${SECRET}}\n  ]\n}\n`);
    assert.throws(() => loadConfig(file), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /is not valid JSON/);
      assert.ok(!error.message.includes(SECRET), error.message);
      return true;
    });
    assert.throws(() => loadConfig(join(dir, 'missing.json')), /cannot read config .*ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('camera sources: allowlist, no credentials, no wrappers, no URLs inside lavfi', () => {
  const printer = { name: 'H2C', host: '192.0.2.10', serial: 'S1', accessCode: 'a' };
  const parse = (source: string) => parseConfig({ printers: [{ ...printer, camera: { source } }] }, tmpdir()).printers[0]?.cameraSource;
  for (const ok of ['rtsp://127.0.0.1:8554/h2c', 'rtsps://relay.local/x', 'http://127.0.0.1:1984/api/stream.mjpeg?src=h2c', '/var/lib/cam.mp4', 'lavfi:testsrc2=size=1680x1080']) {
    assert.equal(parse(ok), ok);
  }
  const refused = [
    `rtsps://bblp:${SECRET}@192.0.2.10:322/streaming/live/1`,
    `rtsps://bblp:${SECRET}@192.0.2.10:bad/live`, // malformed port: not "a file path"
    `async:rtsps://bblp:${SECRET}@192.0.2.10:322/live`,
    `async:http://bblp:${SECRET}@192.0.2.10/x`,
    `concat:rtsp://bblp:${SECRET}@192.0.2.10/x`,
    `lavfi:movie=rtsp\\\\://bblp\\\\:${SECRET}@192.0.2.10/x`,
    'relative/path.mp4',
    'file:/etc/passwd',
  ];
  for (const bad of refused) {
    assert.throws(() => parse(bad), (error: unknown) => {
      assert.ok(error instanceof ConfigError, bad);
      assert.ok(!error.message.includes(SECRET), `the refusal must not echo the source: ${error.message}`);
      return true;
    }, bad);
  }
});

test('state names that are Object.prototype properties do not resolve', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const status = parseStatus({ print: { gcode_state: name } });
    assert.equal(status.state, 'unknown', name);
    assert.doesNotThrow(() => overlayContent({ status, available: true, name: 'H2C', now: new Date(), finishedAt: null }));
  }
});

test('a state-only delta does not make the accumulated status complete', () => {
  const acc = new ReportAccumulator();
  acc.handle(JSON.stringify({ print: { command: 'push_status', gcode_state: 'RUNNING', mc_percent: 4 } }));
  assert.equal(acc.complete, false);
  acc.handle(readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8'));
  assert.equal(acc.complete, true);
});

// A stand-in for the MQTT client, driven by hand.
class FakeMqtt extends EventEmitter {
  published: string[] = [];
  subscribe(_topic: string, _options: unknown, callback: (error: Error | null) => void) {
    callback(null);
    return this;
  }
  publish(_topic: string, payload: string) {
    this.published.push(payload);
    return this;
  }
  connect() {
    return this;
  }
  async endAsync() {}
}

test('reconnect: the old session is forgotten before the client announces it is online', () => {
  const fake = new FakeMqtt();
  const factory = (() => fake) as unknown as MqttFactory;
  const client = new PrinterClient({ name: 'H2C', host: '192.0.2.10', port: 8883, serial: 'S1', accessCode: 'a' }, { load: () => null, save: () => {} }, factory);
  const seen: Array<{ online: boolean; full: boolean; hasStatus: boolean }> = [];
  client.on('online', (online) => seen.push({ online, full: client.hasFullStatus, hasStatus: client.status !== null }));
  client.start();

  fake.emit('connect');
  const full = readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8');
  fake.emit('message', 'device/S1/report', Buffer.from(full));
  assert.equal(client.hasFullStatus, true);
  assert.equal(client.status?.progress, 47);

  fake.emit('close');
  fake.emit('connect'); // reconnected; no report yet
  assert.deepEqual(seen.at(-1), { online: true, full: false, hasStatus: false });
  assert.equal(client.status, null);
  assert.equal(fake.published.length, 2, 'one pushall per session');
});

test('when the parser reports a position, the config error names the line only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bamboozle-cfg-'));
  try {
    const file = join(dir, 'config.json');
    // A missing comma: V8 reports a position for this kind of error.
    writeFileSync(file, `{\n  "printers": []\n  "storagePath": "${SECRET}"\n}\n`);
    assert.throws(() => loadConfig(file), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /is not valid JSON at line 3$/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
