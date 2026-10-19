import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { findLeaks, sanitize } from '../scripts/sanitize-report.ts';

const dir = new URL('./fixtures/', import.meta.url);

test('committed fixtures contain no serials or real addresses', () => {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const name of files) {
    assert.deepEqual(findLeaks(readFileSync(new URL(name, dir), 'utf8')), [], name);
  }
});

test('sanitize removes identifiers and keeps value types', () => {
  const cleaned = sanitize({
    print: {
      subtask_name: 'my_secret_part',
      task_id: '3570',
      ipcam: { rtsp_url: 'rtsps://10.1.2.3:322/streaming/live/1' },
      net: { info: [{ ip: 1001523722, mask: 16777215 }] },
      upgrade_state: { sn: '01P00A000000000', lower_limit: '01.02.00.00', idx2: 123456789 },
      nozzle: { info: [{ id: 0, sn: '20D00A000000000' }] },
      tray: { tag_uid: '1234567890ABCDEF', tray_uuid: 'ABCDEF' },
      mc_percent: 47,
    },
  });
  const text = JSON.stringify(cleaned);
  assert.deepEqual(findLeaks(text), []);
  assert.ok(!text.includes('my_secret_part'));
  assert.ok(!text.includes('3570'));
  assert.ok(text.includes('"idx2":0'), 'idx2 is zeroed and stays a number');
  assert.ok(text.includes('"lower_limit":"01.02.00.00"'), 'firmware versions are not addresses');
  assert.ok(text.includes('rtsps://192.0.2.10:322/streaming/live/1'));
  assert.ok(text.includes('"ip":0'));
  assert.ok(text.includes('"mc_percent":47'));
});

test('findLeaks flags what sanitize must remove', () => {
  assert.deepEqual(findLeaks('{"sn":"01P00A000000000"}'), ['serial-like 01P00A000000000']);
  assert.deepEqual(findLeaks('rtsps://10.1.2.3:322'), ['ipv4 10.1.2.3']);
  assert.deepEqual(findLeaks('{"fun":"14027FF18FFF9CB7","v":"01.02.00.00"}'), []);
});
