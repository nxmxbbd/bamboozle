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
    `lavfi:movie=bblp:${SECRET}@192.0.2.10`,
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

function parseSource(source: string): string | undefined {
  const printer = { name: 'H2C', host: '192.0.2.10', serial: 'S1', accessCode: 'a' };
  return parseConfig({ printers: [{ ...printer, camera: { source } }] }, tmpdir()).printers[0]?.cameraSource;
}

function assertRefused(source: string): void {
  assert.throws(() => parseSource(source), (error: unknown) => {
    assert.ok(error instanceof ConfigError, JSON.stringify(source));
    assert.ok(!error.message.includes(SECRET), `the refusal must not echo the secret: ${error.message}`);
    assert.ok(!error.message.includes(source), `the refusal must not echo the source: ${error.message}`);
    return true;
  }, JSON.stringify(source));
}

test('camera sources: credentials ffmpeg would find without "//" are refused', () => {
  // The URL parser sees no username here; ffmpeg's av_url_split sends bblp:<secret>.
  assertRefused(`rtsp:bblp:${SECRET}@192.0.2.10/live`);
  assertRefused(`rtsps:bblp:${SECRET}@192.0.2.10:322/live`);
  assertRefused(`http:/bblp:${SECRET}@192.0.2.10/live`);
});

test('camera sources: backslashes are refused', () => {
  // For http the URL parser reads "\" as "/", so the host looks like relay.local.
  assertRefused(`http://relay.local\\bblp:${SECRET}@192.0.2.10/live`);
  assertRefused(`https://relay.local\\@192.0.2.10/live`);
  assertRefused('/var/lib/cam\\x.mp4');
});

test('camera sources: an empty user part or an empty host is refused', () => {
  for (const source of ['rtsp://@192.0.2.10/x', 'rtsp://:@192.0.2.10/x', 'rtsp:///x', 'http:///x', 'https://?x', 'rtsp://#x']) assertRefused(source);
});

test('camera sources: control characters are refused', () => {
  for (const control of ['\u0000', '\u0001', '\t', '\n', '\r', '\u001b', '\u001f', '\u007f']) {
    assertRefused(`rtsp://192.0.2.10/li${control}ve`);
  }
  assertRefused(`rtsp://192.0.2.10/live\n`);
  assertRefused(`lavfi:testsrc2\u0000`);
});

test('camera sources: accepted URLs are passed on in canonical form', () => {
  assert.equal(parseSource('HTTP://127.0.0.1:1984/x'), 'http://127.0.0.1:1984/x');
  assert.equal(parseSource('RTSP://127.0.0.1:8554/h2c'), 'rtsp://127.0.0.1:8554/h2c');
  assert.equal(parseSource('https://relay.local'), 'https://relay.local/');
  for (const ok of ['rtsp://127.0.0.1:8554/h2c', 'rtsps://relay.local/x', 'rtsp://[::1]:8554/h2c', 'http://127.0.0.1:1984/api/stream.mjpeg?src=h2c', '/var/lib/cam.mp4', 'lavfi:testsrc2=size=1680x1080']) {
    assert.equal(parseSource(ok), ok);
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

const FIXTURES = ['h2c-printing.json', 'h2c-finished.json', 'h2c-failed-devmode-on.json'];

function fixturePrint(name: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as { print: Record<string, unknown> }).print;
}

function completeAfter(print: Record<string, unknown>): boolean {
  const acc = new ReportAccumulator();
  acc.handle(JSON.stringify({ print }));
  return acc.complete;
}

test('a large report missing a field the status needs is not complete', () => {
  const full = fixturePrint('h2c-printing.json');
  const without = (...keys: string[]) => Object.fromEntries(Object.entries(full).filter(([key]) => !keys.includes(key)));
  const variants: Array<[string, Record<string, unknown>]> = [
    ['no mc_percent', without('mc_percent')],
    ['no mc_remaining_time', without('mc_remaining_time')],
    ['no print_error', without('print_error')],
    ['no gcode_state', without('gcode_state')],
    ['no nozzle temperature at all', without('nozzle_temper', 'device')],
    ['mc_percent as a string', { ...full, mc_percent: '47' }],
    ['device.extruder.info not a list', { ...without('nozzle_temper'), device: { extruder: { info: {} } } }],
  ];
  for (const [label, print] of variants) {
    assert.ok(Object.keys(print).length >= 30, `${label}: still a large report`);
    assert.equal(completeAfter(print), false, label);
  }
  // Either temperature source is enough.
  assert.equal(completeAfter(without('nozzle_temper')), true, 'device.extruder.info alone');
  assert.equal(completeAfter(without('device')), true, 'nozzle_temper alone');
});

// Preservation checks: these two hold with or without the content check;
// the defect-specific cases are the ones around them.
test('each captured pushall reply completes the status', () => {
  for (const name of FIXTURES) assert.equal(completeAfter(fixturePrint(name)), true, name);
});

test('a small state delta does not complete the status', () => {
  assert.equal(completeAfter({ command: 'push_status', gcode_state: 'RUNNING' }), false);
  assert.equal(completeAfter({ command: 'push_status', gcode_state: 'RUNNING', mc_percent: 4, mc_remaining_time: 80 }), false);
});

const SCALARS = { command: 'push_status', gcode_state: 'RUNNING', mc_percent: 47, mc_remaining_time: 86, print_error: 0 };

test('a report whose nozzle temperature the status cannot resolve is not complete', () => {
  const variants: Array<[string, Record<string, unknown>]> = [
    ['empty extruder list', { ...SCALARS, device: { extruder: { info: [] } } }],
    ['an entry without temp', { ...SCALARS, device: { extruder: { info: [{ id: 0 }] } } }],
    ['temp as a string', { ...SCALARS, device: { extruder: { info: [{ id: 0, temp: '220' }] } } }],
    ['only the inactive extruder', { ...SCALARS, device: { extruder: { state: 0x10, info: [{ id: 0, temp: 220 }] } } }],
  ];
  for (const [label, print] of variants) {
    assert.equal(parseStatus(print as never).nozzle, null, `${label}: the status has no nozzle temperature`);
    assert.equal(completeAfter(print), false, label);
  }
  // Controls: the same scalars with a temperature the status can use.
  assert.equal(completeAfter({ ...SCALARS, nozzle_temper: 220 }), true, 'flat nozzle_temper');
  assert.equal(completeAfter({ ...SCALARS, device: { extruder: { state: 0x10, info: [{ id: 1, temp: 220 }] } } }), true, 'active extruder');
});

test('numbers that overflow to Infinity do not complete the status', () => {
  const fields = { ...SCALARS, nozzle_temper: 220 };
  const message = (overflow?: string) =>
    `{"print":{${Object.entries(fields)
      .map(([key, value]) => `"${key}":${key === overflow ? '1e400' : JSON.stringify(value)}`)
      .join(',')}}}`;
  for (const field of ['mc_percent', 'mc_remaining_time', 'print_error', 'nozzle_temper']) {
    const acc = new ReportAccumulator();
    acc.handle(message(field));
    assert.equal(acc.complete, false, field);
  }
  const control = new ReportAccumulator();
  control.handle(message());
  assert.equal(control.complete, true, 'the same message without an overflow');
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
