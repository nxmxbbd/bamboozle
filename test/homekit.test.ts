import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hap from 'hap-nodejs';
import { Characteristic, Service, type Accessory, type WithUUID } from 'hap-nodejs';
import {
  ADVERTISER_CIAO,
  CATEGORY_BRIDGE,
  CATEGORY_SENSOR,
  EVENT_PAIRED,
  EVENT_UNPAIRED,
  STATUS_COMMUNICATION_FAILURE,
} from '../src/homekit/hap-constants.ts';
import { remainingToLux, toDisplay, type DisplayValues } from '../src/homekit/display.ts';
import { PrinterAccessories, SNAP_BACK_MS, type PrinterAccessoryOptions } from '../src/homekit/printer-accessory.ts';
import { generatePincode, generateSetupId, generateUsername, loadOrCreateIdentity } from '../src/homekit/bridge.ts';
import { parseStatus } from '../src/printer/status.ts';
import { VERSION } from '../src/version.ts';
import type { JsonObject } from '../src/printer/merge.ts';

const fixture = (name: string) =>
  parseStatus(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as JsonObject);

test('hap constant literals match the runtime enums', () => {
  assert.equal(CATEGORY_BRIDGE, hap.Categories.BRIDGE);
  assert.equal(CATEGORY_SENSOR, hap.Categories.SENSOR);
  assert.equal(STATUS_COMMUNICATION_FAILURE, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(ADVERTISER_CIAO, hap.MDNSAdvertiser.CIAO);
  assert.equal(EVENT_PAIRED, hap.AccessoryEventTypes.PAIRED);
  assert.equal(EVENT_UNPAIRED, hap.AccessoryEventTypes.UNPAIRED);
});

test('VERSION matches package.json and is numeric x.y.z', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

// --- display mapping -------------------------------------------------------

test('toDisplay: printing fixture', () => {
  const values = toDisplay(fixture('h2c-printing'), true);
  assert.deepEqual(values, {
    available: true,
    printing: true,
    progress: 47,
    remainingMinutes: 86,
    fault: false,
    temperatures: { chamber: 59, nozzle: 265, bed: 100 },
  });
});

test('toDisplay: finished and failed are not printing and show no time left', () => {
  const finished = toDisplay(fixture('h2c-finished'), true);
  assert.equal(finished.printing, false);
  assert.equal(finished.progress, 100);
  assert.equal(finished.remainingMinutes, 0);
  const failed = toDisplay(fixture('h2c-failed-devmode-on'), true);
  assert.equal(failed.printing, false);
  assert.equal(failed.fault, false, 'a cancelled / failed job without an error code is not a fault');
});

test('toDisplay: fault on print_error or fatal HMS only', () => {
  const base = fixture('h2c-printing');
  assert.equal(toDisplay({ ...base, printError: 0x03008008 }, true).fault, true);
  const fatal = { code: '0300_0100_0001_0007', severity: 'fatal' as const, attr: 0, rawCode: 0 };
  assert.equal(toDisplay({ ...base, hms: [fatal] }, true).fault, true);
  assert.equal(toDisplay(base, true).fault, false, 'the fixture carries a "serious" HMS, which is not a fault');
});

test('toDisplay: unavailable without a status or while offline; clamps progress', () => {
  assert.equal(toDisplay(null, true).available, false);
  assert.equal(toDisplay(fixture('h2c-printing'), false).available, false);
  const base = fixture('h2c-printing');
  assert.equal(toDisplay({ ...base, progress: 140 }, true).progress, 100);
  assert.equal(toDisplay({ ...base, progress: -3 }, true).progress, 0);
  assert.equal(toDisplay({ ...base, progress: 47.6 }, true).progress, 48);
});

test('remainingToLux respects the HomeKit floor', () => {
  assert.equal(remainingToLux(0), 0.0001);
  assert.equal(remainingToLux(222), 222);
});

// --- accessories -----------------------------------------------------------

const ALL: PrinterAccessoryOptions = {
  name: 'H2C',
  serial: 'SERIAL1',
  model: 'H2C',
  progress: ['humidity', 'window', 'fan', 'lightbulb'],
  temperatures: ['chamber', 'nozzle', 'bed'],
  layout: 'grouped',
};

function find(accessories: Accessory[], type: typeof Service.HumiditySensor, subtype: string): Service {
  for (const accessory of accessories) {
    const service = accessory.getServiceById(type, subtype);
    if (service) return service;
  }
  throw new Error(`no ${subtype} service`);
}

const value = (service: Service, type: WithUUID<new () => Characteristic>) => service.getCharacteristic(type).value;

function printing(): DisplayValues {
  return toDisplay(fixture('h2c-printing'), true);
}

test('grouped layout: one accessory carrying every service', () => {
  const printer = new PrinterAccessories(ALL);
  assert.equal(printer.accessories.length, 1);
  printer.update(printing());
  const a = printer.accessories;
  assert.equal(value(find(a, Service.HumiditySensor, 'progress-humidity'), Characteristic.CurrentRelativeHumidity), 47);
  assert.equal(value(find(a, Service.WindowCovering, 'progress-window'), Characteristic.CurrentPosition), 47);
  assert.equal(value(find(a, Service.WindowCovering, 'progress-window'), Characteristic.TargetPosition), 47);
  assert.equal(value(find(a, Service.Fanv2, 'progress-fan'), Characteristic.RotationSpeed), 47);
  assert.equal(value(find(a, Service.Fanv2, 'progress-fan'), Characteristic.Active), 1);
  assert.equal(value(find(a, Service.Lightbulb, 'progress-lightbulb'), Characteristic.Brightness), 47);
  assert.equal(value(find(a, Service.Lightbulb, 'progress-lightbulb'), Characteristic.On), true);
  assert.equal(value(find(a, Service.LightSensor, 'remaining'), Characteristic.CurrentAmbientLightLevel), 86);
  assert.equal(value(find(a, Service.OccupancySensor, 'printing'), Characteristic.OccupancyDetected), 1);
  assert.equal(value(find(a, Service.ContactSensor, 'fault'), Characteristic.ContactSensorState), 0);
  assert.equal(value(find(a, Service.TemperatureSensor, 'temperature-nozzle'), Characteristic.CurrentTemperature), 265);
  assert.equal(value(find(a, Service.TemperatureSensor, 'temperature-bed'), Characteristic.CurrentTemperature), 100);
  assert.equal(value(find(a, Service.TemperatureSensor, 'temperature-chamber'), Characteristic.CurrentTemperature), 59);
});

test('separate layout: one accessory per tile, ids stable across restarts', () => {
  const first = new PrinterAccessories({ ...ALL, layout: 'separate' });
  // printing + fault + 4 progress styles + minutes left + 3 temperatures
  assert.equal(first.accessories.length, 10);
  const again = new PrinterAccessories({ ...ALL, layout: 'separate' });
  assert.deepEqual(first.accessories.map((a) => a.UUID), again.accessories.map((a) => a.UUID));
  assert.equal(new Set(first.accessories.map((a) => a.UUID)).size, 10);
  const grouped = new PrinterAccessories(ALL);
  assert.equal(grouped.accessories[0]?.UUID, new PrinterAccessories(ALL).accessories[0]?.UUID);
  const other = new PrinterAccessories({ ...ALL, serial: 'SERIAL2' });
  assert.notEqual(grouped.accessories[0]?.UUID, other.accessories[0]?.UUID);
});

test('only the configured styles and sensors are created', () => {
  const printer = new PrinterAccessories({ ...ALL, progress: ['humidity'], temperatures: ['chamber'] });
  const services = printer.accessories[0]!.services.map((s) => s.subtype).filter(Boolean);
  assert.deepEqual(services.sort(), ['fault', 'printing', 'progress-humidity', 'remaining', 'temperature-chamber']);
});

test('extended temperature range: a 265 °C nozzle is not clipped', () => {
  const printer = new PrinterAccessories(ALL);
  const nozzle = find(printer.accessories, Service.TemperatureSensor, 'temperature-nozzle');
  assert.equal(nozzle.getCharacteristic(Characteristic.CurrentTemperature).props.maxValue, 400);
});

test('every characteristic reports No Response while unavailable, and recovers', () => {
  const printer = new PrinterAccessories(ALL);
  printer.update(printing());
  printer.update({ ...printing(), available: false });
  for (const accessory of printer.accessories) {
    for (const service of accessory.services) {
      if (service.UUID === Service.AccessoryInformation.UUID) continue;
      for (const characteristic of service.characteristics) {
        if (characteristic.UUID === Characteristic.Name.UUID || characteristic.UUID === Characteristic.ConfiguredName.UUID) continue;
        assert.equal(characteristic.statusCode, STATUS_COMMUNICATION_FAILURE, `${service.subtype}/${characteristic.displayName}`);
      }
    }
  }
  printer.update(printing());
  const humidity = find(printer.accessories, Service.HumiditySensor, 'progress-humidity').getCharacteristic(Characteristic.CurrentRelativeHumidity);
  assert.equal(humidity.statusCode, 0);
  assert.equal(humidity.value, 47);
});

test('reads are served from the latest values and fail while unavailable', async () => {
  const printer = new PrinterAccessories(ALL);
  const humidity = find(printer.accessories, Service.HumiditySensor, 'progress-humidity').getCharacteristic(Characteristic.CurrentRelativeHumidity);
  await assert.rejects(humidity.handleGetRequest());
  printer.update(printing());
  assert.equal(await humidity.handleGetRequest(), 47);
});

test('writes to repurposed controls snap back to the real value', async () => {
  const printer = new PrinterAccessories(ALL);
  printer.update(printing());
  const blind = find(printer.accessories, Service.WindowCovering, 'progress-window').getCharacteristic(Characteristic.TargetPosition);
  const fan = find(printer.accessories, Service.Fanv2, 'progress-fan').getCharacteristic(Characteristic.RotationSpeed);
  const light = find(printer.accessories, Service.Lightbulb, 'progress-lightbulb').getCharacteristic(Characteristic.On);
  await blind.handleSetRequest(0);
  await fan.handleSetRequest(100);
  await light.handleSetRequest(false);
  await new Promise((resolve) => setTimeout(resolve, SNAP_BACK_MS + 100));
  assert.equal(blind.value, 47);
  assert.equal(fan.value, 47);
  assert.equal(light.value, true);
});

test('accessory information names the printer', () => {
  const printer = new PrinterAccessories(ALL);
  const info = printer.accessories[0]!.getService(Service.AccessoryInformation)!;
  assert.equal(info.getCharacteristic(Characteristic.Manufacturer).value, 'Bambu Lab');
  assert.equal(info.getCharacteristic(Characteristic.Model).value, 'H2C');
  assert.equal(info.getCharacteristic(Characteristic.SerialNumber).value, 'SERIAL1');
  assert.equal(info.getCharacteristic(Characteristic.FirmwareRevision).value, VERSION);
});

// --- bridge identity -------------------------------------------------------

test('generated identities follow the HomeKit rules', () => {
  for (let i = 0; i < 200; i++) {
    const code = generatePincode();
    assert.match(code, /^\d{3}-\d{2}-\d{3}$/);
    const digits = code.replaceAll('-', '');
    assert.notEqual(digits, '12345678');
    assert.notEqual(digits, '87654321');
    assert.ok(!/^(\d)\1{7}$/.test(digits));
    const username = generateUsername();
    assert.match(username, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    const first = parseInt(username.slice(0, 2), 16);
    assert.equal(first & 0x03, 0x02, 'unicast and locally administered');
    assert.match(generateSetupId(), /^[0-9A-Z]{4}$/);
  }
});

test('the identity is created once, private, and reused', () => {
  const storage = mkdtempSync(join(tmpdir(), 'bamboozle-bridge-'));
  try {
    const first = loadOrCreateIdentity(storage);
    assert.equal(statSync(join(storage, 'bridge.json')).mode & 0o777, 0o600);
    assert.deepEqual(loadOrCreateIdentity(storage), first);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});
