// The Resume switch end to end: the real serve() against fake printers over
// TLS, paired with an independent HAP controller, pressing the switch the way
// the Home app does, with a real program as the configured command.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Characteristic, Service } from '@homebridge/hap-nodejs';
import { HttpClient } from 'hap-controller';
import { parseConfig } from '../src/config.ts';
import { STATUS_NOT_ALLOWED_IN_CURRENT_STATE } from '../src/homekit/hap-constants.ts';
import { serve } from '../src/serve.ts';
import { fakePrinter, type FakePrinter } from './support/fake-printer.ts';
import { fullType, type HapAccessory, type HapCharacteristic } from './support/hap.ts';
import { freePort } from './support/ports.ts';
import { tlsIdentity } from './support/tls.ts';
import { until } from './support/until.ts';

interface Printer {
  name: string;
  serial: string;
  state: 'PAUSE' | 'RUNNING';
  resume: boolean;
  listenOnly?: boolean;
}
const PAUSED: Printer = { name: 'Paused', serial: 'TESTRES1', state: 'PAUSE', resume: true };
const BUSY: Printer = { name: 'Busy', serial: 'TESTRES2', state: 'RUNNING', resume: true };
const PLAIN: Printer = { name: 'Plain', serial: 'TESTRES3', state: 'PAUSE', resume: false };
const QUIET: Printer = { name: 'Quiet', serial: 'TESTRES4', state: 'PAUSE', resume: true, listenOnly: true };
/** Paused and never pressed by a paired client before the unpaired try: a press there would run. */
const FRESH: Printer = { name: 'Fresh', serial: 'TESTRES5', state: 'PAUSE', resume: true };
const ALL = [PAUSED, BUSY, PLAIN, QUIET, FRESH];

function find(accessory: HapAccessory, service: string, type: string): HapCharacteristic | undefined {
  return accessory.services.find((s) => fullType(s.type) === service)?.characteristics.find((c) => fullType(c.type) === type);
}

let dir = '';
let marks = '';
let running = false;
let client: HttpClient | null = null;
let stop: (() => Promise<void>) | null = null;
let bridgePort = 0;
let db: HapAccessory[] = [];
const fakes: FakePrinter[] = [];
const logs: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bamboozle-resume-e2e-'));
  marks = join(dir, 'marks.txt');
  // The "resume" program: records who asked and with what, answers one line.
  const program = join(dir, 'resume-it');
  writeFileSync(program, `#!/bin/sh\necho "$BAMBOOZLE_PRINTER $*" >> ${marks}\necho "resumed $BAMBOOZLE_PRINTER"\n`);
  chmodSync(program, 0o755);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8')) as { print: Record<string, unknown> };
  for (const printer of ALL) {
    const identity = tlsIdentity(dir, printer.serial);
    if (!identity) return; // no openssl: skipped
    const report = Buffer.from(JSON.stringify({ print: { ...fixture.print, gcode_state: printer.state } }));
    fakes.push(await fakePrinter({ identity, serial: printer.serial, report, behaviour: printer.listenOnly ? 'reports unasked' : 'answers when asked' }));
  }
  const port = await freePort();
  bridgePort = port;
  const config = parseConfig(
    {
      printers: ALL.map((printer, i) => ({
        name: printer.name,
        host: '127.0.0.1',
        port: fakes[i]?.port,
        serial: printer.serial,
        accessCode: '12345678',
        ...(printer.resume ? { resumeCommand: [program, '--from-home'] } : {}),
        ...(printer.listenOnly ? { listenOnly: true } : {}),
      })),
      bridge: { name: 'bamboozle resume test', port, bind: ['127.0.0.1'] },
    },
    dir,
  );
  stop = await serve(config, { simulate: false, log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } });
  const identity = JSON.parse(readFileSync(join(dir, 'storage', 'bridge.json'), 'utf8')) as { username: string; pincode: string };
  client = new HttpClient(identity.username, '127.0.0.1', port);
  await client.pairSetup(identity.pincode);
  db = ((await client.getAccessories()) as unknown as { accessories: HapAccessory[] }).accessories;
  running = true;
});

after(async () => {
  try {
    await client?.close();
  } finally {
    try {
      await stop?.();
    } finally {
      for (const fake of fakes) fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function switchOf(printer: Printer): string | null {
  for (const accessory of db) {
    if (find(accessory, Service.AccessoryInformation.UUID, Characteristic.SerialNumber.UUID)?.value !== printer.serial) continue;
    const on = find(accessory, Service.Switch.UUID, Characteristic.On.UUID);
    if (on) return `${accessory.aid}.${on.iid}`;
  }
  return null;
}

async function read(id: string): Promise<{ value?: unknown; status?: number }> {
  type Answer = { characteristics?: Array<{ value?: unknown; status?: number }> };
  const answer = (await (client as HttpClient).getCharacteristics([id]).catch((error: unknown) => error)) as Answer & { body?: Answer };
  return answer.characteristics?.[0] ?? answer.body?.characteristics?.[0] ?? {};
}

/** Writes On like the Home app; the HAP status per characteristic (0 = accepted). */
async function press(id: string, value: boolean): Promise<number> {
  type Answer = { characteristics?: Array<{ status?: number }> };
  try {
    const answer = (await (client as HttpClient).setCharacteristics({ [id]: value })) as Answer;
    return answer.characteristics?.[0]?.status ?? 0;
  } catch (error) {
    // A refused write carries its HAP status; anything else is a failure, never an "accepted".
    const status = (error as { body?: Answer }).body?.characteristics?.[0]?.status;
    if (typeof status === 'number') return status;
    throw error;
  }
}

/** HAP sends booleans as 0 / 1. */
const isOff = (value: unknown) => value === false || value === 0;

/** What bamboozle published to a printer: only the status request (none to a listen-only one). */
const published = (printer: Printer) => fakes[ALL.indexOf(printer)]?.seen.publishes.map((p) => p.topic) ?? [];

const marked = () => (existsSync(marks) ? readFileSync(marks, 'utf8') : '');

test('only a printer with a resumeCommand gets a Resume switch', (t) => {
  if (!running) return t.skip('no openssl');
  assert.ok(switchOf(PAUSED));
  assert.ok(switchOf(BUSY));
  assert.equal(switchOf(PLAIN), null);
});

test('pressing Resume on a paused printer runs the command once, as configured, and the switch settles off', async (t) => {
  if (!running) return t.skip('no openssl');
  const id = switchOf(PAUSED) as string;
  await until(async () => isOff((await read(id)).value), 'the paused printer to report');
  const before = published(PAUSED);
  assert.equal(before.length, 1, 'the status request');
  assert.equal(await press(id, false), 0, 'off is accepted');
  await delay(500);
  assert.equal(marked(), '', 'and does nothing');
  assert.equal(await press(id, true), 0);
  await until(() => marked() !== '', 'the command to run');
  await until(async () => isOff((await read(id)).value), 'the switch to go off');
  assert.equal(marked(), 'Paused --from-home\n');
  assert.deepEqual(published(PAUSED), before, 'a press publishes nothing to the printer');
  await until(() => logs.some((line) => line === '[Paused] resume accepted: resumed Paused'), 'the log line');
});

test('pressing Resume on a printer that is not paused is refused and runs nothing', async (t) => {
  if (!running) return t.skip('no openssl');
  const id = switchOf(BUSY) as string;
  await until(async () => isOff((await read(id)).value), 'the busy printer to report');
  const before = marked();
  assert.equal(await press(id, true), STATUS_NOT_ALLOWED_IN_CURRENT_STATE);
  await delay(500);
  assert.equal(marked(), before);
});

test('a listen-only printer with a command: the press runs it, and still nothing is published to the printer', async (t) => {
  if (!running) return t.skip('no openssl');
  const id = switchOf(QUIET) as string;
  await until(async () => isOff((await read(id)).value), 'the listen-only printer to report');
  assert.equal(await press(id, true), 0);
  await until(() => marked().includes('Quiet --from-home'), 'the command to run');
  assert.deepEqual(published(QUIET), []);
});

test('a client that never paired cannot press it: the bridge refuses the write and nothing runs', async (t) => {
  if (!running) return t.skip('no openssl');
  const id = switchOf(FRESH) as string;
  await until(async () => isOff((await read(id)).value), 'the fresh printer to report');
  const [aid, iid] = id.split('.').map(Number);
  const before = marked();
  const body = JSON.stringify({ characteristics: [{ aid, iid, value: true }] });
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: bridgePort, method: 'PUT', path: '/characteristics', headers: { 'content-type': 'application/hap+json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(status, 470, 'HAP: connection authorization required');
  await delay(500);
  assert.equal(marked(), before);
  // The same switch was pressable: the paired client's press runs it.
  assert.equal(await press(id, true), 0);
  await until(() => marked().includes('Fresh --from-home'), 'the paired press to run');
});
