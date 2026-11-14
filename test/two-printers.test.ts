// One bridge, two printers: an H2C that is asked for its status and a
// listen-only H3C that reports unasked. The real serve() runs against two
// fake printers (TLS and MQTT on loopback), and an independent HomeKit
// controller (hap-controller) reads back what the Home app would get.
// Advertises on loopback only.

import { test, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Characteristic, Service } from '@homebridge/hap-nodejs';
import { HttpClient } from 'hap-controller';
import { parseConfig } from '../src/config.ts';
import { STATUS_COMMUNICATION_FAILURE } from '../src/homekit/hap-constants.ts';
import { serve } from '../src/serve.ts';
import { CONNECT, PUBLISH, SUBSCRIBE, fakePrinter, sent, type FakePrinter } from './support/fake-printer.ts';
import { hasFfmpeg } from './support/ffmpeg.ts';
import { fullType, type HapAccessory, type HapCharacteristic } from './support/hap.ts';
import { freePort } from './support/ports.ts';
import { tlsIdentity, type TlsIdentity } from './support/tls.ts';
import { until } from './support/until.ts';

/** One of the two printers: what it is called, what it sends, what that report says, and what its camera shows. */
interface Printer {
  name: string;
  serial: string;
  accessCode: string;
  fixture: string;
  progress: number;
  chamber: number;
  layers: string;
  listenOnly: boolean;
  /** Its camera source is one plain colour, so a snapshot shows whose camera it came from. */
  picture: 'red' | 'blue';
}

const H2C: Printer = { name: 'H2C', serial: 'TESTH2C1', accessCode: '12345678', fixture: 'h2c-printing', progress: 47, chamber: 59, layers: '24/120', listenOnly: false, picture: 'red' };
const H3C: Printer = { name: 'H3C', serial: 'TESTH3C1', accessCode: '87654321', fixture: 'h3c-printing', progress: 78, chamber: 39, layers: '122/238', listenOnly: true, picture: 'blue' };
const BOTH = [H2C, H3C];

let dir = '';
let storage = '';
let port = 0;
let stop: (() => Promise<void>) | null = null;
let client: HttpClient | null = null;
let db: HapAccessory[] = [];
const identities = new Map<Printer, TlsIdentity>();
const fakes = new Map<Printer, FakePrinter>();
const logs: string[] = [];
const warnings: string[] = [];
/** What the log says about the bridge and the printers (the pairing code left out), for failure messages. */
const logged = () => ['the log:', ...logs.filter((line) => /^(\[|bridge |paired )/.test(line))].join('\n');
/** False without openssl (no certificate for the fake printers): every test here is skipped then. */
let running = false;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bamboozle-two-'));
  storage = join(dir, 'storage');
  for (const printer of BOTH) {
    const identity = tlsIdentity(dir, printer.serial);
    if (!identity) return;
    identities.set(printer, identity);
  }
  for (const printer of BOTH) {
    fakes.set(
      printer,
      await fakePrinter({
        identity: identities.get(printer) as TlsIdentity,
        serial: printer.serial,
        report: readFileSync(new URL(`./fixtures/${printer.fixture}.json`, import.meta.url)),
        behaviour: printer.listenOnly ? 'reports unasked' : 'answers when asked',
      }),
    );
  }
  port = await freePort();
  const config = parseConfig(
    {
      printers: BOTH.map((printer) => ({
        name: printer.name,
        model: printer.name,
        host: '127.0.0.1',
        port: fakes.get(printer)?.port,
        serial: printer.serial,
        accessCode: printer.accessCode,
        ...(printer.listenOnly ? { listenOnly: true } : {}),
        camera: { source: `lavfi:color=c=${printer.picture}:size=1680x1080:rate=15` },
      })),
      bridge: { name: 'bamboozle test', port, bind: ['127.0.0.1'] },
    },
    dir,
  );
  stop = await serve(config, { simulate: false, log: { log: (m: string) => logs.push(m), warn: (m: string) => warnings.push(m) } });
  const identity = JSON.parse(readFileSync(join(storage, 'bridge.json'), 'utf8')) as { username: string; pincode: string };
  client = new HttpClient(identity.username, '127.0.0.1', port);
  await client.pairSetup(identity.pincode);
  db = ((await client.getAccessories()) as unknown as { accessories: HapAccessory[] }).accessories;
  running = true;
});

// Each step runs whatever the one before it did: a fake printer left listening would keep the test process alive.
after(async () => {
  try {
    await client?.close();
  } finally {
    try {
      await stop?.();
    } finally {
      for (const fake of fakes.values()) fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function characteristic(accessory: HapAccessory, service: string, type: string): HapCharacteristic | undefined {
  return accessory.services.find((s) => fullType(s.type) === service)?.characteristics.find((c) => fullType(c.type) === type);
}

/** A printer's accessories: the ones that carry its serial number. */
function accessoriesOf(printer: Printer): HapAccessory[] {
  return db.filter((a) => characteristic(a, Service.AccessoryInformation.UUID, Characteristic.SerialNumber.UUID)?.value === printer.serial);
}

/** "aid.iid" of a characteristic on one of a printer's accessories. */
function idOf(printer: Printer, service: string, type: string): string {
  for (const accessory of accessoriesOf(printer)) {
    const found = characteristic(accessory, service, type);
    if (found) return `${accessory.aid}.${found.iid}`;
  }
  return assert.fail(`${printer.name} has no characteristic ${type} on a service ${service}`);
}

const progressOf = (printer: Printer) => idOf(printer, Service.Fanv2.UUID, Characteristic.RotationSpeed.UUID);

/** Reads one characteristic now: its value, or the HAP status when the bridge refuses the read. */
async function read(id: string): Promise<{ value?: unknown; status?: number }> {
  type Answer = { characteristics?: Array<{ value?: unknown; status?: number }> };
  const answer = (await (client as HttpClient).getCharacteristics([id]).catch((error: unknown) => error)) as Answer & { body?: Answer };
  return answer.characteristics?.[0] ?? answer.body?.characteristics?.[0] ?? {};
}

let waited: Promise<void> | null = null;
/**
 * Waits until both printers have reported, or the time for that is up. The
 * tests that read what a printer sent start here, in whatever order or
 * selection they run; the wait happens once, so when a printer never reports,
 * each of them still gets to fail on its own check.
 */
function reports(): Promise<void> {
  waited ??= (async () => {
    for (const printer of BOTH) {
      await until(async () => (await read(progressOf(printer))).value !== undefined, `the ${printer.name} to report`, 15_000, 100).catch(() => {});
    }
  })();
  return waited;
}

/** The average colour of a JPEG as [red, green, blue], worked out by ffmpeg. */
function averageColour(image: Buffer): [number, number, number] {
  const pixel = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: image });
  return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
}

/** Skips the test when there is no bridge to test; true when it did. */
function skipped(t: TestContext): boolean {
  if (running) return false;
  t.skip('openssl not available');
  return true;
}

test('one bridge carries both printers, five accessories each under its own serial number', (t) => {
  if (skipped(t)) return;
  assert.equal(db.length, 11, 'the bridge itself and five accessories per printer');
  for (const printer of BOTH) {
    const mine = accessoriesOf(printer);
    const info = (type: string) => mine.map((a) => characteristic(a, Service.AccessoryInformation.UUID, type)?.value);
    assert.deepEqual(
      info(Characteristic.Name.UUID).sort(),
      ['Camera', 'Chamber', 'Fault', 'Printing', 'Progress Fan'].map((label) => `${printer.name} ${label}`),
    );
    assert.deepEqual(info(Characteristic.Model.UUID), Array(5).fill(printer.name));
  }
  assert.ok(logs.includes(`bridge "bamboozle test" on port ${port} (127.0.0.1), 2 camera(s)`), logged());
});

test("each printer's tiles show its own report", async (t) => {
  if (skipped(t)) return;
  await reports();
  for (const printer of BOTH) {
    const value = async (service: string, type: string) => (await read(idOf(printer, service, type))).value;
    assert.notEqual(await value(Service.Fanv2.UUID, Characteristic.RotationSpeed.UUID), undefined, `the ${printer.name} has not reported`);
    assert.ok(logs.includes(`[${printer.name}] connected`), logged());
    assert.equal(await value(Service.Fanv2.UUID, Characteristic.RotationSpeed.UUID), printer.progress, printer.name);
    assert.equal(await value(Service.TemperatureSensor.UUID, Characteristic.CurrentTemperature.UUID), printer.chamber, printer.name);
    assert.equal(await value(Service.OccupancySensor.UUID, Characteristic.OccupancyDetected.UUID), 1, printer.name);
    assert.equal(await value(Service.ContactSensor.UUID, Characteristic.ContactSensorState.UUID), 0, printer.name);
  }
});

test("each camera's overlay text comes from its own printer", async (t) => {
  if (skipped(t)) return;
  await reports();
  for (const printer of BOTH) {
    const text = (file: string) => readFileSync(join(storage, 'overlay', printer.serial, `${file}.txt`), 'utf8');
    assert.equal(text('name'), printer.name);
    assert.equal(text('big'), `${printer.progress}%`);
    assert.equal(text('detail-layer'), printer.layers);
  }
});

test('each camera serves a snapshot of its own source over HAP', { skip: !hasFfmpeg && 'ffmpeg not available' }, async (t) => {
  if (skipped(t)) return;
  await reports();
  for (const printer of BOTH) {
    const camera = accessoriesOf(printer).find((a) => a.services.some((s) => fullType(s.type) === Service.CameraRTPStreamManagement.UUID));
    assert.ok(camera, `${printer.name} has a camera`);
    const image = await (client as HttpClient).getImage(640, 360, camera.aid);
    assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8', printer.name);
    // The overlay darkens the picture and writes on it, but one colour still leads by far.
    const [red, , blue] = averageColour(image);
    const lead = printer.picture === 'red' ? red - blue : blue - red;
    assert.ok(lead > 60, `the ${printer.name} camera shows a ${printer.picture} picture (red ${red}, blue ${blue})`);
  }
});

test("each printer's certificate is pinned under its own serial", async (t) => {
  if (skipped(t)) return;
  await reports();
  const pins = BOTH.map((printer) => readFileSync(join(storage, 'pins', `${printer.serial}.sha256`), 'utf8').trim());
  assert.deepEqual(pins, BOTH.map((printer) => new X509Certificate((identities.get(printer) as TlsIdentity).cert).fingerprint256));
  assert.notEqual(pins[0], pins[1]);
});

test('a printer whose connection closes takes only its own tiles with it, and a listen-only one comes back by itself', { timeout: 60_000 }, async (t) => {
  if (skipped(t)) return;
  await reports();
  const earlier = (fakes.get(H3C) as FakePrinter).seen.logins.length;
  (fakes.get(H3C) as FakePrinter).drop();
  await until(async () => (await read(progressOf(H3C))).status === STATUS_COMMUNICATION_FAILURE, 'the H3C tiles to show No Response', 15_000, 100);
  assert.equal((await read(progressOf(H2C))).value, H2C.progress, 'the H2C is still there');
  assert.ok(logs.includes('[H3C] disconnected'), logged());
  // The client connects again after five seconds, and the fake printer sends its report again, unasked.
  await until(async () => (await read(progressOf(H3C))).value === H3C.progress, 'the H3C to be back', 30_000, 100);
  assert.equal((fakes.get(H3C) as FakePrinter).seen.logins.length, earlier + 1, 'one new connection after the old one closed');
  assert.equal((await read(progressOf(H2C))).value, H2C.progress);
  assert.ok(!logs.includes('[H2C] disconnected'), logged());
});

// Last: it stops the bridge, so that everything the printers were sent has been read.
test('on the wire, the H2C was asked for its status once and the listen-only H3C never, each on its own topic with its own access code', async (t) => {
  if (skipped(t)) return;
  await reports();
  await client?.close();
  client = null;
  await stop?.();
  stop = null;
  const [h2c, h3c] = BOTH.map((printer) => fakes.get(printer) as FakePrinter) as [FakePrinter, FakePrinter];
  await h2c.hungUp();
  await h3c.hungUp();

  assert.deepEqual(sent(h2c.seen), [CONNECT, SUBSCRIBE, PUBLISH]);
  assert.deepEqual(h2c.seen.subscriptions, [`device/${H2C.serial}/report`]);
  assert.equal(h2c.seen.publishes[0]?.topic, `device/${H2C.serial}/request`);
  assert.equal((JSON.parse(h2c.seen.publishes[0]?.payload ?? '{}') as { pushing?: { command?: string } }).pushing?.command, 'pushall');
  assert.deepEqual(h2c.seen.logins, [{ username: 'bblp', password: H2C.accessCode }]);

  // However often it connected (twice, when its connection was closed above): a login and a subscription, and not a single publish.
  const connections = h3c.seen.logins.length;
  assert.ok(connections > 0);
  assert.deepEqual(sent(h3c.seen), Array(connections).fill([CONNECT, SUBSCRIBE]).flat());
  assert.deepEqual(h3c.seen.subscriptions, Array(connections).fill(`device/${H3C.serial}/report`));
  assert.deepEqual(h3c.seen.publishes, []);
  assert.deepEqual(h3c.seen.logins, Array(connections).fill({ username: 'bblp', password: H3C.accessCode }));

  assert.equal(h2c.seen.unparsed + h3c.seen.unparsed, 0);
  assert.deepEqual(warnings.filter((warning) => warning.startsWith('[H2C]')), [], 'the H2C connection had no trouble');
});
