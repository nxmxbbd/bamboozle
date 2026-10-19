// Example addresses in the code, the tests and the docs must not point at
// anyone's real network: only loopback, the unspecified address and the
// RFC 5737 documentation ranges. The fixture check covers captured reports;
// this one covers everything a person writes by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPV4 } from '../scripts/sanitize-report.ts';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

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

/** Every file a push would publish: the tracked ones and new ones git does not ignore. */
function files(): string[] {
  const list = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: rootPath, encoding: 'utf8' });
  // join, not new URL(): a URL would cut a name at '#' or '?' and drop it silently.
  return list.split('\0').filter((name) => name !== '' && existsSync(join(rootPath, name)));
}

/** Git's own test: a NUL byte near the start means binary. */
const isBinary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0);

test('hand-written files use only loopback or documentation IPv4 addresses', () => {
  const list = files();
  assert.ok(list.includes('test/peer.test.ts'), 'the walk reaches the tests');
  for (const file of ['.gitignore', 'tsconfig.json', 'docker/go2rtc.yaml', 'Dockerfile']) {
    assert.ok(list.includes(file), `the walk reaches ${file}`);
  }
  const found: string[] = [];
  for (const file of list) {
    const bytes = readFileSync(join(rootPath, file));
    if (isBinary(bytes)) continue;
    for (const match of bytes.toString('utf8').matchAll(IPV4)) {
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

test('the address pattern finds an address wherever prose puts it, and nothing longer', () => {
  const found = (text: string) => [...text.matchAll(IPV4)].map((m) => m[0]);
  assert.deepEqual(found('Reach it at 192.0.2.20.'), ['192.0.2.20']);
  assert.deepEqual(found('(198.51.100.1), "198.51.100.2"; 203.0.113.3:8883'), ['198.51.100.1', '198.51.100.2', '203.0.113.3']);
  assert.deepEqual(found('firmware 1.2.3.4.5 and 01.02.03.04'), []);
});

test('files that hold the access code or the pairing keys are never published', () => {
  // Where init, the README and the compose file put them, at any depth.
  const secrets = [
    'config.json', 'docker/config.json',
    'printer.code', 'docker/printer.code', 'h2c.code',
    'data/config.json', 'docker/data/printer.code',
    'storage/bridge.json', 'docker/data/storage/bridge.json',
  ];
  const published = secrets.filter((path) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: fileURLToPath(root) });
      return false; // exit 0: ignored
    } catch {
      return true;
    }
  });
  assert.deepEqual(published, []);
});
