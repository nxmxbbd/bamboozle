import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, parseConfig } from '../src/config.ts';

const base = { name: 'H2C', host: '192.0.2.10', serial: 'SERIAL1' };

test('inline access code, defaults for port and storage', () => {
  const config = parseConfig({ printers: [{ ...base, accessCode: ' 12345678 ' }] }, '/srv/bamboozle');
  assert.deepEqual(config.printers, [{ ...base, port: 8883, accessCode: '12345678' }]);
  assert.equal(config.storagePath, '/srv/bamboozle/storage');
});

test('access code from a file, resolved relative to the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bamboozle-config-'));
  try {
    writeFileSync(join(dir, 'h2c.code'), '87654321\n');
    const config = parseConfig({ printers: [{ ...base, accessCodeFile: 'h2c.code' }], storagePath: 'state' }, dir);
    assert.equal(config.printers[0]?.accessCode, '87654321');
    assert.equal(config.storagePath, join(dir, 'state'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects invalid configs with a pointed message', () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    [{ printers: [] }, /non-empty array/],
    [{ printers: [{ ...base }] }, /printers\[0\]\.accessCode/],
    [{ printers: [{ ...base, accessCode: 'a', accessCodeFile: 'b' }] }, /not both/],
    [{ printers: [{ ...base, host: '', accessCode: 'a' }] }, /printers\[0\]\.host/],
    [{ printers: [{ ...base, port: 70000, accessCode: 'a' }] }, /port/],
    [{ printers: [{ ...base, accessCodeFile: 'missing.code' }] }, /cannot read/],
    [{ printers: [{ ...base, accessCode: 'a' }, { ...base, name: 'B', accessCode: 'b' }] }, /duplicate printer serial/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseConfig(raw, tmpdir()), (error: unknown) => error instanceof ConfigError && message.test(error.message));
  }
});

test('config errors never echo the access code', () => {
  try {
    parseConfig({ printers: [{ ...base, accessCode: 'secret-code', port: 'x' }] }, tmpdir());
    assert.fail('expected an error');
  } catch (error) {
    assert.ok(!(error as Error).message.includes('secret-code'));
  }
});

test('bridge and display defaults', () => {
  const config = parseConfig({ printers: [{ ...base, accessCode: 'a' }] }, '/srv');
  assert.deepEqual(config.bridge, { name: 'bamboozle', port: 51827 });
  assert.deepEqual(config.display, { progress: ['humidity'], temperatures: ['chamber'], layout: 'grouped' });
});

test('bridge and display overrides', () => {
  const config = parseConfig(
    {
      printers: [{ ...base, model: 'H2C', accessCode: 'a' }],
      bridge: { name: 'Printers', port: 51900, bind: ['10.0.0.5'] },
      display: { progress: ['window', 'fan'], temperatures: [], layout: 'separate' },
    },
    '/srv',
  );
  assert.equal(config.printers[0]?.model, 'H2C');
  assert.deepEqual(config.bridge, { name: 'Printers', port: 51900, bind: ['10.0.0.5'] });
  assert.deepEqual(config.display, { progress: ['window', 'fan'], temperatures: [], layout: 'separate' });
});

test('rejects bad bridge and display settings', () => {
  const printer = { ...base, accessCode: 'a' };
  const cases: Array<[unknown, RegExp]> = [
    [{ printers: [printer], bridge: { port: 0 } }, /bridge\.port/],
    [{ printers: [printer], bridge: { bind: [] } }, /bridge\.bind/],
    [{ printers: [printer], display: { progress: ['thermometer'] } }, /unknown value "thermometer"/],
    [{ printers: [printer], display: { progress: ['fan', 'fan'] } }, /listed twice/],
    [{ printers: [printer], display: { temperatures: 'nozzle' } }, /must be an array/],
    [{ printers: [printer], display: { layout: 'stacked' } }, /display\.layout/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseConfig(raw, tmpdir()), (error: unknown) => error instanceof ConfigError && message.test(error.message));
  }
});
