import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReport, type JsonObject } from '../src/printer/merge.ts';

test('scalars in a delta replace previous values', () => {
  const merged = mergeReport({ mc_percent: 10, gcode_state: 'RUNNING' }, { mc_percent: 11 });
  assert.deepEqual(merged, { mc_percent: 11, gcode_state: 'RUNNING' });
});

test('nested objects merge recursively', () => {
  const previous: JsonObject = { device: { bed: { info: { temp: 6553700 }, state: 2 }, ctc: { state: 2 } } };
  const merged = mergeReport(previous, { device: { bed: { info: { temp: 6553699 } } } });
  assert.deepEqual(merged, { device: { bed: { info: { temp: 6553699 }, state: 2 }, ctc: { state: 2 } } });
});

test('arrays of id-keyed entries merge per entry', () => {
  const previous: JsonObject = {
    extruder: { info: [{ id: 0, temp: 17367305, stat: 1 }, { id: 1, temp: 85 }] },
  };
  const merged = mergeReport(previous, { extruder: { info: [{ id: 1, temp: 90 }] } });
  assert.deepEqual(merged, { extruder: { info: [{ id: 0, temp: 17367305, stat: 1 }, { id: 1, temp: 90 }] } });
});

test('a new keyed entry is appended', () => {
  const merged = mergeReport({ list: [{ id: 0, v: 1 }] }, { list: [{ id: 2, v: 3 }] });
  assert.deepEqual(merged, { list: [{ id: 0, v: 1 }, { id: 2, v: 3 }] });
});

test('node-keyed arrays (lights_report) merge per node', () => {
  const previous: JsonObject = {
    lights_report: [
      { node: 'chamber_light', mode: 'on' },
      { node: 'work_light', mode: 'flashing' },
    ],
  };
  const merged = mergeReport(previous, { lights_report: [{ node: 'chamber_light', mode: 'off' }] });
  assert.deepEqual(merged.lights_report, [
    { node: 'chamber_light', mode: 'off' },
    { node: 'work_light', mode: 'flashing' },
  ]);
});

test('unkeyed arrays (hms) are replaced, so a cleared error disappears', () => {
  const merged = mergeReport({ hms: [{ attr: 1, code: 2 }] }, { hms: [] });
  assert.deepEqual(merged.hms, []);
});

test('an empty array replaces a keyed one', () => {
  const merged = mergeReport({ list: [{ id: 0 }] }, { list: [] });
  assert.deepEqual(merged.list, []);
});

test('a type change replaces instead of merging', () => {
  assert.deepEqual(mergeReport({ a: { b: 1 } }, { a: 5 }), { a: 5 });
  assert.deepEqual(mergeReport({ a: 5 }, { a: { b: 1 } }), { a: { b: 1 } });
  assert.deepEqual(mergeReport({ a: [1, 2] }, { a: { b: 1 } }), { a: { b: 1 } });
});

test('inputs are not mutated', () => {
  const previous: JsonObject = { device: { bed: { state: 1 } }, list: [{ id: 0, v: 1 }] };
  const snapshot = structuredClone(previous);
  mergeReport(previous, { device: { bed: { state: 2 } }, list: [{ id: 0, v: 9 }] });
  assert.deepEqual(previous, snapshot);
});
