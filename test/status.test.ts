import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatus, unpackTemperature } from '../src/printer/status.ts';
import type { JsonObject } from '../src/printer/merge.ts';

function fixture(name: string): JsonObject {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as JsonObject;
}

test('H2C printing, Developer Mode off', () => {
  const status = parseStatus(fixture('h2c-printing'));
  assert.equal(status.state, 'printing');
  assert.equal(status.gcodeState, 'RUNNING');
  assert.equal(status.progress, 47);
  assert.equal(status.remainingMinutes, 86);
  assert.equal(status.layer, 24);
  assert.equal(status.totalLayers, 120);
  assert.deepEqual(status.nozzles, [
    { id: 0, current: 265, target: 265 },
    { id: 1, current: 85, target: 0 },
  ]);
  assert.equal(status.activeNozzleId, 0);
  assert.deepEqual(status.nozzle, { current: 265, target: 265 });
  assert.deepEqual(status.bed, { current: 100, target: 100 });
  assert.deepEqual(status.chamber, { current: 59, target: 60 });
  assert.equal(status.chamberLight, true);
  assert.deepEqual(
    status.hms.map(({ code, severity }) => ({ code, severity })),
    [{ code: '0C00_0300_0002_0012', severity: 'serious' }],
  );
  assert.equal(status.printError, 0);
  assert.equal(status.signatureRequired, true);
});

test('H2C finished', () => {
  const status = parseStatus(fixture('h2c-finished'));
  assert.equal(status.state, 'finished');
  assert.equal(status.progress, 100);
  assert.equal(status.remainingMinutes, 0);
  assert.equal(status.activeNozzleId, 0);
  assert.deepEqual(status.nozzle, { current: 44, target: 0 });
  assert.deepEqual(status.bed, { current: 60, target: 0 });
  assert.deepEqual(status.chamber, { current: 39, target: 0 });
  assert.deepEqual(status.hms, []);
  assert.equal(status.signatureRequired, true);
});

test('H2C failed with Developer Mode on; second extruder active', () => {
  const status = parseStatus(fixture('h2c-failed-devmode-on'));
  assert.equal(status.state, 'failed');
  assert.equal(status.signatureRequired, false);
  // extruder.state 274 = 0x112 -> bits 4-7 = 1
  assert.equal(status.activeNozzleId, 1);
  assert.deepEqual(status.nozzle, { current: 107, target: 0 });
  assert.deepEqual(status.bed, { current: 27, target: 0 });
});

test('accepts the bare print object as well as the wrapped message', () => {
  const wrapped = fixture('h2c-printing');
  assert.deepEqual(parseStatus(wrapped['print'] as JsonObject), parseStatus(wrapped));
});

test('older printers: flat temperature fields, no extruder list', () => {
  const status = parseStatus({
    print: {
      gcode_state: 'PAUSE',
      mc_percent: 12,
      nozzle_temper: 219.5,
      nozzle_target_temper: 220,
      bed_temper: 55,
      bed_target_temper: 55,
      chamber_temper: 31,
      lights_report: [{ node: 'chamber_light', mode: 'off' }],
    },
  });
  assert.equal(status.state, 'paused');
  assert.deepEqual(status.nozzles, []);
  assert.equal(status.activeNozzleId, null);
  assert.deepEqual(status.nozzle, { current: 219.5, target: 220 });
  assert.deepEqual(status.bed, { current: 55, target: 55 });
  assert.deepEqual(status.chamber, { current: 31, target: 0 });
  assert.equal(status.chamberLight, false);
});

test('empty report yields unknowns, not crashes or fake zeros', () => {
  const status = parseStatus({});
  assert.equal(status.state, 'unknown');
  assert.equal(status.gcodeState, null);
  assert.equal(status.progress, null);
  assert.equal(status.remainingMinutes, null);
  assert.equal(status.nozzle, null);
  assert.equal(status.bed, null);
  assert.equal(status.chamber, null);
  assert.equal(status.chamberLight, null);
  assert.equal(status.signatureRequired, null);
  assert.deepEqual(status.hms, []);
});

test('unrecognised or malformed values degrade to null', () => {
  const status = parseStatus({
    print: {
      gcode_state: 'SOMETHING_NEW',
      mc_percent: '47',
      fun: 'not-hex',
      lights_report: [{ node: 'chamber_light', mode: 'flashing' }],
      hms: [{ attr: 'x', code: 1 }, null, 5],
      device: { extruder: { state: 2, info: [{ id: 0 }, { temp: 5 }] } },
    },
  });
  assert.equal(status.state, 'unknown');
  assert.equal(status.gcodeState, 'SOMETHING_NEW');
  assert.equal(status.progress, null);
  assert.equal(status.signatureRequired, null);
  assert.equal(status.chamberLight, null);
  assert.deepEqual(status.hms, []);
  assert.deepEqual(status.nozzles, []);
  assert.equal(status.nozzle, null);
});

test('active extruder id with no matching entry falls back to flat fields', () => {
  const status = parseStatus({
    print: { nozzle_temper: 30, device: { extruder: { state: 0x50, info: [{ id: 0, temp: 25 }] } } },
  });
  assert.equal(status.activeNozzleId, null);
  assert.deepEqual(status.nozzle, { current: 30, target: 0 });
});

test('unpackTemperature', () => {
  assert.deepEqual(unpackTemperature(17367305), { current: 265, target: 265 });
  assert.deepEqual(unpackTemperature(3932219), { current: 59, target: 60 });
  assert.deepEqual(unpackTemperature(27), { current: 27, target: 0 });
  assert.deepEqual(unpackTemperature(0), { current: 0, target: 0 });
});
