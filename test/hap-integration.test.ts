// End to end over real HAP: start a bridge, pair with an independent HomeKit
// controller implementation (hap-controller), and read back exactly what the
// Home app would receive. Advertises on loopback only, so running the tests
// does not announce a bridge on the local network.

import { test, after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Characteristic, Service } from '@homebridge/hap-nodejs';
import { HttpClient } from 'hap-controller';
import { startBridge, type RunningBridge } from '../src/homekit/bridge.ts';
import { PrinterCamera } from '../src/camera/camera.ts';
import { resolveFonts } from '../src/camera/fonts.ts';
import { toDisplay } from '../src/homekit/display.ts';
import { STATUS_COMMUNICATION_FAILURE } from '../src/homekit/hap-constants.ts';
import { isValidHomeKitName } from '../src/homekit/names.ts';
import { PrinterAccessories, SNAP_BACK_MS } from '../src/homekit/printer-accessory.ts';
import { parseStatus } from '../src/printer/status.ts';
import type { JsonObject } from '../src/printer/merge.ts';

interface HapCharacteristic {
  iid: number;
  type: string;
  value?: unknown;
  perms: string[];
}
interface HapService {
  iid: number;
  type: string;
  primary?: boolean;
  characteristics: HapCharacteristic[];
}
interface HapAccessory {
  aid: number;
  services: HapService[];
}

const HAP_BASE = '-0000-1000-8000-0026BB765291';
/** HAP-NodeJS reports Apple types in short form ("10"); expand for comparison. */
function fullType(type: string): string {
  return /^[0-9A-F]{1,8}$/i.test(type) ? `${type.toUpperCase().padStart(8, '0')}${HAP_BASE}` : type.toUpperCase();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const status = parseStatus(
  JSON.parse(readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8')) as JsonObject,
);

let storage = '';
let port = 0;
let bridge: RunningBridge;
let client: HttpClient;
let printer: PrinterAccessories;
let camera: PrinterCamera;
let db: HapAccessory[] = [];
const warnings: string[] = [];
const logs: string[] = [];

before(async () => {
  storage = realpathSync(mkdtempSync(join(tmpdir(), 'bamboozle-hap-'))); // the full-disk test matches paths as written
  port = await freePort();
  printer = new PrinterAccessories({
    name: 'H2C',
    serial: 'SERIAL1',
    model: 'H2C',
    progress: ['humidity', 'window', 'fan', 'lightbulb'],
    countdown: ['lux'],
    temperatures: ['chamber', 'nozzle', 'bed'],
    layout: 'grouped',
  });
  printer.update(toDisplay(status, true));
  camera = new PrinterCamera({
    name: 'H2C',
    serial: 'SERIAL1',
    source: 'lavfi:testsrc2=size=1680x1080:rate=15',
    overlayDir: join(storage, 'overlay'),
    fonts: resolveFonts(),
    ffmpeg: { path: 'ffmpeg', encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' },
  });
  camera.update({ status, available: true, name: 'H2C', now: new Date(), finishedAt: null });
  bridge = await startBridge({ name: 'bamboozle test', port, bind: ['127.0.0.1'], storagePath: storage, log: { log: (m: string) => logs.push(m), warn: (m: string) => warnings.push(m) }, cameraSettingsRetryMs: 300 }, [
    ...printer.accessories,
    camera.accessory,
  ]);
  client = new HttpClient(bridge.identity.username, '127.0.0.1', port);
  await client.pairSetup(bridge.identity.pincode);
  db = ((await client.getAccessories()) as unknown as { accessories: HapAccessory[] }).accessories;
});

after(async () => {
  await client?.close();
  await camera?.stop();
  await bridge?.stop();
  rmSync(storage, { recursive: true, force: true });
});

const CAMERA_STREAM_MANAGEMENT = Service.CameraRTPStreamManagement.UUID;

function cameraAccessory(): HapAccessory {
  const found = db.find((a) => a.services.some((s) => fullType(s.type) === CAMERA_STREAM_MANAGEMENT));
  assert.ok(found, 'a camera accessory');
  return found;
}

function printerAccessory(): HapAccessory {
  const found = db.find((a) => a.aid !== 1 && !a.services.some((s) => fullType(s.type) === CAMERA_STREAM_MANAGEMENT));
  assert.ok(found, 'a bridged printer accessory');
  return found;
}

function service(type: string): HapService {
  const found = printerAccessory().services.find((s) => fullType(s.type) === type.toUpperCase());
  assert.ok(found, `service ${type}`);
  return found;
}

function characteristic(svc: HapService, type: string): HapCharacteristic {
  const found = svc.characteristics.find((c) => fullType(c.type) === type.toUpperCase());
  assert.ok(found, `characteristic ${type}`);
  return found;
}

test('pairing succeeds and the bridge reports itself paired', () => {
  assert.equal(bridge.isPaired(), true);
  assert.equal(db.length, 3, 'the bridge itself, one grouped printer accessory and its camera');
});

test('every Name and ConfiguredName the controller sees is valid', () => {
  for (const accessory of db) {
    for (const svc of accessory.services) {
      for (const c of svc.characteristics) {
        const type = fullType(c.type);
        if (type !== Characteristic.Name.UUID && type !== Characteristic.ConfiguredName.UUID) continue;
        assert.ok(isValidHomeKitName(String(c.value)), `aid ${accessory.aid} name "${String(c.value)}"`);
      }
    }
  }
});

test('the grouped tile leads with the humidity progress', () => {
  const primary = printerAccessory().services.filter((s) => s.primary);
  assert.equal(primary.length, 1);
  assert.equal(fullType(primary[0]!.type), Service.HumiditySensor.UUID);
});

test('values over the wire match the printer status', () => {
  const v = (svc: string, ch: string) => characteristic(service(svc), ch).value;
  assert.equal(v(Service.HumiditySensor.UUID, Characteristic.CurrentRelativeHumidity.UUID), 47);
  assert.equal(v(Service.WindowCovering.UUID, Characteristic.CurrentPosition.UUID), 47);
  assert.equal(v(Service.Fanv2.UUID, Characteristic.RotationSpeed.UUID), 47);
  assert.equal(v(Service.Lightbulb.UUID, Characteristic.Brightness.UUID), 47);
  assert.equal(v(Service.LightSensor.UUID, Characteristic.CurrentAmbientLightLevel.UUID), 86);
  assert.equal(v(Service.OccupancySensor.UUID, Characteristic.OccupancyDetected.UUID), 1);
  assert.equal(v(Service.ContactSensor.UUID, Characteristic.ContactSensorState.UUID), 0);
  const temps = printerAccessory()
    .services.filter((s) => fullType(s.type) === Service.TemperatureSensor.UUID)
    .map((s) => characteristic(s, Characteristic.CurrentTemperature.UUID).value)
    .sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(temps, [59, 100, 265]);
});

test('read-only progress characteristics are not writable', () => {
  const humidity = characteristic(service(Service.HumiditySensor.UUID), Characteristic.CurrentRelativeHumidity.UUID);
  assert.ok(!humidity.perms.includes('pw'));
  const lux = characteristic(service(Service.LightSensor.UUID), Characteristic.CurrentAmbientLightLevel.UUID);
  assert.ok(!lux.perms.includes('pw'));
});

test('a write from the controller snaps back to the real progress', async () => {
  const target = characteristic(service(Service.WindowCovering.UUID), Characteristic.TargetPosition.UUID);
  const id = `${printerAccessory().aid}.${target.iid}`;
  await client.setCharacteristics({ [id]: 0 });
  await new Promise((resolve) => setTimeout(resolve, SNAP_BACK_MS + 200));
  const read = (await client.getCharacteristics([id])) as { characteristics: Array<{ value: unknown }> };
  assert.equal(read.characteristics[0]?.value, 47);
});

test('while the printer is unreachable the controller gets a communication failure', async () => {
  const humidity = characteristic(service(Service.HumiditySensor.UUID), Characteristic.CurrentRelativeHumidity.UUID);
  const id = `${printerAccessory().aid}.${humidity.iid}`;
  printer.update({ ...toDisplay(status, true), available: false });
  const failing = (await client.getCharacteristics([id]).catch((error: unknown) => error)) as {
    characteristics?: Array<{ status?: number }>;
    body?: { characteristics?: Array<{ status?: number }> };
  };
  const entry = failing.characteristics?.[0] ?? failing.body?.characteristics?.[0];
  assert.equal(entry?.status, STATUS_COMMUNICATION_FAILURE);
  printer.update(toDisplay(status, true));
  const ok = (await client.getCharacteristics([id])) as { characteristics: Array<{ value: unknown }> };
  assert.equal(ok.characteristics[0]?.value, 47);
});

test('the camera serves an overlaid JPEG snapshot over HAP', async () => {
  const image = await client.getImage(640, 360, cameraAccessory().aid);
  assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
  assert.ok(image.length > 5000, `a real picture, ${image.length} bytes`);
});

/** Polls instead of guessing how long a timer takes on a busy machine. */
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(50);
  }
}

test('a camera setting changed on a full disk is saved once there is space, without a crash', async () => {
  const camera = cameraAccessory();
  const rtp = camera.services.find((s) => fullType(s.type) === CAMERA_STREAM_MANAGEMENT);
  assert.ok(rtp, 'camera stream management');
  const id = `${camera.aid}.${characteristic(rtp, Characteristic.Active.UUID).iid}`;
  const hap = join(storage, 'hap');
  const file = join(hap, `ControllerStorage.${bridge.identity.username.replaceAll(':', '')}.json`);
  const saved = () => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  // Off and on again with space first, so there are saved settings to keep.
  await client.setCharacteristics({ [id]: 0 });
  await until(() => saved() !== null, 'a first save');
  const first = saved();
  await client.setCharacteristics({ [id]: 1 });
  await until(() => saved() !== first, 'the camera turned on to be saved');
  const before = saved();
  const write = fs.writeFileSync;
  let failed = 0;
  mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
    if (typeof file === 'string' && file.startsWith(hap)) {
      failed++;
      write(file, '');
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return write(file, data as string, options);
  });
  syncBuiltinESMExports();
  try {
    // HAP-NodeJS saves camera settings ~100 ms after the change, from a timer.
    await client.setCharacteristics({ [id]: 0 }); // the camera turned off
    await until(() => failed >= 2, 'the save and one retry to fail');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(warnings.filter((w) => /camera settings not saved: ENOSPC/.test(w)).length, 1, warnings.join('\n'));
  assert.equal(saved(), before, 'the saved settings are untouched');

  // Space again, and nothing else changes: the off is saved by the retry.
  await until(() => saved() !== before, 'the retry to save');
  const off = saved();
  assert.ok(logs.some((l) => l === 'camera settings saved again'), logs.join('\n'));

  // Still serving, and later changes are saved as usual.
  await client.setCharacteristics({ [id]: 1 });
  await until(() => saved() !== off, 'the camera turned on to be saved');
});

// Last: it stops the bridge.
test('stopping right after a camera setting changes still saves it', async () => {
  const camera = cameraAccessory();
  const rtp = camera.services.find((s) => fullType(s.type) === CAMERA_STREAM_MANAGEMENT);
  assert.ok(rtp, 'camera stream management');
  const id = `${camera.aid}.${characteristic(rtp, Characteristic.Active.UUID).iid}`;
  const file = join(storage, 'hap', `ControllerStorage.${bridge.identity.username.replaceAll(':', '')}.json`);
  const before = readFileSync(file, 'utf8');
  await client.setCharacteristics({ [id]: 0 }); // HAP-NodeJS would save it ~100 ms from now
  await client.close();
  const stopping = Date.now();
  await bridge.stop();
  const tookMs = Date.now() - stopping;
  assert.notEqual(readFileSync(file, 'utf8'), before, `the camera turned off is saved by stop() (took ${tookMs} ms)`);
});
