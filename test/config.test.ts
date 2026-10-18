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
