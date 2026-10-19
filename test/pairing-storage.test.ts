import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPairingFiles, writeAtomically } from '../src/homekit/pairing-storage.ts';

const dir = mkdtempSync(join(tmpdir(), 'bamboozle-pairing-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const USERNAME = '0E:11:22:33:44:57';
const KEYS = 'AccessoryInfo.0E1122334457.json';
const GOOD_KEYS = JSON.stringify({ signSk: 'ab'.repeat(64), signPk: 'cd'.repeat(32), pairedClients: {} });

let counter = 0;
function hapDir(files: Record<string, string>): string {
  const hap = join(dir, `hap-${++counter}`);
  mkdirSync(hap);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(hap, name), text);
  return hap;
}

test('pairing files: a missing directory, an empty one, and readable files all pass', () => {
  checkPairingFiles(join(dir, 'never-created'), USERNAME);
  checkPairingFiles(hapDir({}), USERNAME);
  checkPairingFiles(hapDir({ [KEYS]: GOOD_KEYS, 'IdentifierCache.0E1122334457.json': '{"cache":{}}' }), USERNAME);
});

test('pairing files: dot files and directories are not pairing files', () => {
  const hap = hapDir({ [KEYS]: GOOD_KEYS, [`.${KEYS}.tmp`]: '' });
  mkdirSync(join(hap, 'subdir'));
  checkPairingFiles(hap, USERNAME);
});

test('pairing files: each unreadable shape stops the bridge, naming the file and the problem', () => {
  const cases: Array<[string, string, string]> = [
    [KEYS, '', 'empty'],
    [KEYS, ' \n\t', 'empty'],
    [KEYS, '{"signSk":', 'not JSON'],
    [KEYS, 'null', 'not a JSON object'],
    [KEYS, '[]', 'not a JSON object'],
    [KEYS, '"text"', 'not a JSON object'],
    [KEYS, JSON.stringify({ signPk: 'cd'.repeat(32) }), 'no signSk'],
    [KEYS, JSON.stringify({ signSk: 'ab'.repeat(64), signPk: '' }), 'no signPk'],
    [KEYS, JSON.stringify({ signSk: 'not hex', signPk: 'cd'.repeat(32) }), 'no signSk'],
    ['IdentifierCache.0E1122334457.json', '', 'empty'],
    ['ControllerStorage.0E1122334457.json', '{', 'not JSON'],
  ];
  for (const [name, text, found] of cases) {
    const hap = hapDir({ ...(name === KEYS ? {} : { [KEYS]: GOOD_KEYS }), [name]: text });
    assert.throws(
      () => checkPairingFiles(hap, USERNAME),
      (error: Error) => error.message.startsWith(`${join(hap, name)} cannot be read (${found}).`) && error.message.includes(`Restore ${hap} from a backup`),
      `${name} = ${JSON.stringify(text)}`,
    );
  }
});

test('pairing files: only this bridge\'s AccessoryInfo must carry keys', () => {
  checkPairingFiles(hapDir({ [KEYS]: GOOD_KEYS, 'AccessoryInfo.0E0000000001.json': '{"displayName":"old bridge"}' }), USERNAME);
  checkPairingFiles(hapDir({ 'IdentifierCache.0E1122334457.json': '{"cache":{}}' }), USERNAME);
});

test('writeAtomically: writes the content privately and leaves no temporary file', () => {
  const target = join(dir, 'atomic', 'file.json');
  mkdirSync(join(dir, 'atomic'));
  writeAtomically(target, 'first');
  writeAtomically(target, 'second');
  assert.equal(readFileSync(target, 'utf8'), 'second');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, 'atomic')), ['file.json']);
});

test('writeAtomically: a failed write keeps the old content and cleans up', () => {
  const folder = join(dir, 'atomic-fail');
  mkdirSync(join(folder, 'target'), { recursive: true });
  writeFileSync(join(folder, 'target', 'inside'), 'keep');
  // Renaming a file over a non-empty directory fails after the temporary file is written.
  assert.throws(() => writeAtomically(join(folder, 'target'), 'new'));
  assert.deepEqual(readdirSync(folder), ['target']);
  assert.equal(readFileSync(join(folder, 'target', 'inside'), 'utf8'), 'keep');
});
