// Example addresses in the code, the tests and the docs must not point at
// anyone's real network: only loopback, the unspecified address and the
// RFC 5737 documentation ranges. The fixture check covers captured reports;
// this one covers everything a person writes by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { IPV4 } from '../scripts/sanitize-report.ts';

const root = new URL('../', import.meta.url);

// Deliberate non-documentation inputs: the sanitizer tests and this file feed
// these in to prove they get flagged or replaced.
const EXEMPT: Record<string, string[]> = {
  'test/fixtures.test.ts': ['10.1.2.3'],
  'test/addresses.test.ts': ['10.1.2.3', '10.0.0.1', '192.0.20.1', '198.51.10.1'],
};

const allowed = (ip: string) =>
  ip === '0.0.0.0' ||
  ip.startsWith('127.') ||
  ip.startsWith('192.0.2.') ||
  ip.startsWith('198.51.100.') ||
  ip.startsWith('203.0.113.');

function files(): string[] {
  const out = ['README.md'];
  for (const dir of ['src', 'test', 'scripts']) {
    for (const name of readdirSync(new URL(`${dir}/`, root), { recursive: true }) as string[]) {
      if (/\.(ts|json|md)$/.test(name)) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

test('hand-written files use only loopback or documentation IPv4 addresses', () => {
  const list = files();
  assert.ok(list.includes('test/peer.test.ts'), 'the walk reaches the tests');
  const found: string[] = [];
  for (const file of list) {
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const match of text.matchAll(IPV4)) {
      if (!allowed(match[0]) && !EXEMPT[file]?.includes(match[0])) found.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the address check knows a real address from a documentation one', () => {
  assert.equal(allowed('192.0.2.50'), true);
  assert.equal(allowed('127.0.0.2'), true);
  assert.equal(allowed('10.0.0.1'), false);
  assert.equal(allowed('192.0.20.1'), false);
  assert.equal(allowed('198.51.10.1'), false);
});
