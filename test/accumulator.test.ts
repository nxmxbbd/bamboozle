import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ReportAccumulator } from '../src/printer/accumulator.ts';

const full = readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8');

test('a full report completes the status; later deltas update it', () => {
  const acc = new ReportAccumulator();
  const first = acc.handle(full);
  assert.ok(first);
  assert.equal(acc.complete, true);
  assert.equal(first.progress, 47);

  const next = acc.handle(JSON.stringify({ print: { command: 'push_status', mc_percent: 48, mc_remaining_time: 84 } }));
  assert.ok(next);
  assert.equal(next.progress, 48);
  assert.equal(next.remainingMinutes, 84);
  assert.equal(next.state, 'printing', 'fields absent from the delta keep their value');
  assert.deepEqual(next.chamber, { current: 59, target: 60 });
});

test('deltas before any full report do not mark the status complete', () => {
  const acc = new ReportAccumulator();
  const status = acc.handle(JSON.stringify({ print: { command: 'push_status', mc_percent: 5 } }));
  assert.ok(status);
  assert.equal(status.progress, 5);
  assert.equal(status.state, 'unknown');
  assert.equal(acc.complete, false);
});

test('non-status messages and garbage are ignored', () => {
  const acc = new ReportAccumulator();
  assert.equal(acc.handle('not json'), null);
  assert.equal(acc.handle('[1,2]'), null);
  assert.equal(acc.handle(JSON.stringify({ info: { command: 'get_version' } })), null);
  assert.equal(acc.handle(JSON.stringify({ print: { command: 'extrusion_cali_get', gcode_state: 'X' } })), null);
  assert.equal(acc.complete, false);
});

test('reset forgets everything', () => {
  const acc = new ReportAccumulator();
  acc.handle(full);
  acc.reset();
  assert.equal(acc.complete, false);
  const status = acc.handle(JSON.stringify({ print: { command: 'push_status', mc_percent: 1 } }));
  assert.equal(status?.gcodeState, null);
});
