import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHms, hmsWikiUrl } from '../src/printer/hms.ts';

test('decodes attr + code into the wiki form', () => {
  const entry = decodeHms(201327360, 131090);
  assert.equal(entry.code, '0C00_0300_0002_0012');
  assert.equal(entry.severity, 'serious');
});

test('severity comes from the high half of the code', () => {
  assert.equal(decodeHms(0x03000100, 0x00010007).severity, 'fatal');
  assert.equal(decodeHms(0x03000100, 0x00030007).severity, 'common');
  assert.equal(decodeHms(0x03000100, 0x00040007).severity, 'info');
  assert.equal(decodeHms(0x03000100, 0x00090007).severity, 'unknown');
  assert.equal(decodeHms(0x03000100, 0x00000007).severity, 'unknown');
});

test('values with the top bit set are treated as unsigned', () => {
  assert.equal(decodeHms(0x80000000, 0).code, '8000_0000_0000_0000');
  assert.equal(decodeHms(-1, -1).code, 'FFFF_FFFF_FFFF_FFFF');
});

test('wiki url: H2 path, generic fallback', () => {
  assert.equal(
    hmsWikiUrl('0C00_0300_0002_0012', 'h2'),
    'https://wiki.bambulab.com/en/h2/troubleshooting/hmscode/0C00_0300_0002_0012',
  );
  assert.equal(hmsWikiUrl('0C00_0300_0002_0012', null), 'https://wiki.bambulab.com/en/hms/home');
});
