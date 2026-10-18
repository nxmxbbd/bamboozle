// End to end over real HAP: start a bridge, pair with an independent HomeKit
// controller implementation (hap-controller), and read back exactly what the
// Home app would receive. Advertises on loopback only, so running the tests
// does not announce a bridge on the local network.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Characteristic, Service } from 'hap-nodejs';
import { HttpClient } from 'hap-controller';
import { startBridge, type RunningBridge } from '../src/homekit/bridge.ts';
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
let db: HapAccessory[] = [];

before(async () => {
  storage = mkdtempSync(join(tmpdir(), 'bamboozle-hap-'));
  port = await freePort();
  printer = new PrinterAccessories({
    name: 'H2C',
    serial: 'SERIAL1',
    model: 'H2C',
    progress: ['humidity', 'window', 'fan', 'lightbulb'],
    temperatures: ['chamber', 'nozzle', 'bed'],
    layout: 'grouped',
  });
  printer.update(toDisplay(status, true));
  bridge = await startBridge({ name: 'bamboozle test', port, bind: ['127.0.0.1'], storagePath: storage }, printer.accessories);
  client = new HttpClient(bridge.identity.username, '127.0.0.1', port);
  await client.pairSetup(bridge.identity.pincode);
  db = ((await client.getAccessories()) as unknown as { accessories: HapAccessory[] }).accessories;
});

after(async () => {
  await client?.close();
  await bridge?.stop();
  rmSync(storage, { recursive: true, force: true });
});

function printerAccessory(): HapAccessory {
  const found = db.find((a) => a.aid !== 1);
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
  assert.equal(db.length, 2, 'the bridge itself plus one grouped printer accessory');
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
