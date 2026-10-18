import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedPrinter, simulatedStatus } from '../src/sim.ts';

const CYCLE = 100;

test('a cycle runs preparing, printing 0 -> 100, finished, idle', () => {
  assert.equal(simulatedStatus(2, CYCLE).state, 'preparing');
  const start = simulatedStatus(8, CYCLE);
  assert.equal(start.state, 'printing');
  assert.equal(start.progress, 0);
  assert.equal(simulatedStatus(44, CYCLE).progress, 50);
  assert.equal(simulatedStatus(79.9, CYCLE).progress, 100);
  assert.equal(simulatedStatus(84, CYCLE).state, 'finished');
  assert.equal(simulatedStatus(95, CYCLE).state, 'idle');
  assert.equal(simulatedStatus(102, CYCLE).state, 'preparing', 'the cycle repeats');
});

test('progress rises and time left falls monotonically while printing', () => {
  let lastProgress = -1;
  let lastRemaining = Infinity;
  for (let t = 8; t < 80; t += 0.5) {
    const status = simulatedStatus(t, CYCLE);
    assert.ok((status.progress ?? 0) >= lastProgress);
    assert.ok((status.remainingMinutes ?? 0) <= lastRemaining);
    lastProgress = status.progress ?? 0;
    lastRemaining = status.remainingMinutes ?? 0;
  }
});

test('the fault flashes briefly around 50 %', () => {
  const faults = [];
  for (let t = 0; t < CYCLE; t += 0.25) if (simulatedStatus(t, CYCLE).printError !== 0) faults.push(t);
  assert.ok(faults.length > 0);
  assert.ok(faults.every((t) => t > 40 && t < 50));
});

test('SimulatedPrinter emits online and statuses, then stops', async () => {
  const sim = new SimulatedPrinter({ cycleSeconds: 10, tickMs: 20 });
  const events: string[] = [];
  sim.on('online', (online) => events.push(`online:${online}`));
  sim.on('status', () => events.push('status'));
  sim.start();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(sim.hasFullStatus, true);
  await sim.stop();
  assert.equal(events[0], 'online:true');
  assert.ok(events.filter((e) => e === 'status').length >= 2);
  assert.equal(events.at(-1), 'online:false');
});
