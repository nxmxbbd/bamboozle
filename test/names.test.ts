import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Characteristic, Service } from 'hap-nodejs';
import { homeKitName, isValidHomeKitName } from '../src/homekit/names.ts';
import { PrinterAccessories, type PrinterAccessoryOptions } from '../src/homekit/printer-accessory.ts';

test('the HomeKit naming rule', () => {
  for (const ok of ['H2C', 'H2C Progress', "Sam's printer", '打印机', '3D 打印 进度', 'Printer 2', 'A']) {
    assert.ok(isValidHomeKitName(ok), ok);
  }
  for (const bad of ['Progress (blind)', 'H2C-Progress', 'Printer ', ' Printer', "Printer'", 'Printer!', '🖨️ Printer', '', 'a/b']) {
    assert.ok(!isValidHomeKitName(bad), bad);
  }
});

test('homeKitName sanitizes into a valid name', () => {
  const cases: Array<[string, string]> = [
    ['Progress (blind)', 'Progress blind'],
    ['H2C-Progress', 'H2C Progress'],
    ['  Garage   H2C  ', 'Garage H2C'],
    ['🖨️ Printer #2!', 'Printer 2'],
    ['Sam’s printer', "Sam's printer"],
    ["'quoted'", 'quoted'],
    ['打印机（车库）', '打印机 车库'],
    ['!!!', 'Printer'],
  ];
  for (const [raw, expected] of cases) {
    const name = homeKitName(raw);
    assert.equal(name, expected, raw);
    assert.ok(isValidHomeKitName(name), name);
  }
  assert.equal(homeKitName('', 'bamboozle'), 'bamboozle');
});

const ALL: PrinterAccessoryOptions = {
  name: 'H2C (garage) 🖨️',
  serial: 'SERIAL1',
  progress: ['humidity', 'window', 'fan', 'lightbulb'],
  temperatures: ['chamber', 'nozzle', 'bed'],
  layout: 'grouped',
};

test('every name bamboozle hands to HomeKit is valid, in both layouts', () => {
  for (const layout of ['grouped', 'separate'] as const) {
    const printer = new PrinterAccessories({ ...ALL, layout });
    for (const accessory of printer.accessories) {
      assert.ok(isValidHomeKitName(accessory.displayName), `${layout} accessory "${accessory.displayName}"`);
      for (const service of accessory.services) {
        for (const type of [Characteristic.Name, Characteristic.ConfiguredName]) {
          if (!service.testCharacteristic(type)) continue;
          const value = String(service.getCharacteristic(type).value ?? '');
          if (value === '') continue;
          assert.ok(isValidHomeKitName(value), `${layout} ${service.subtype ?? 'info'} name "${value}"`);
        }
      }
    }
  }
});

test('grouped layout: the first progress style is the primary service', () => {
  const printer = new PrinterAccessories({ ...ALL, progress: ['window', 'humidity'] });
  const primary = printer.accessories[0]!.services.filter((s) => s.isPrimaryService);
  assert.deepEqual(primary.map((s) => s.subtype), ['progress-window']);
  assert.equal(primary[0]?.UUID, Service.WindowCovering.UUID);
});
