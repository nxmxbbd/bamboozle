import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkPairingFiles, savePairingFile, writeAtomically } from '../src/homekit/pairing-storage.ts';

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
      (error: Error) => error.message.startsWith(`${join(hap, name)} cannot be read (${found}).`),
      `${name} = ${JSON.stringify(text)}`,
    );
  }
});

test('pairing files: the advice fits the file, and never says to drop good keys', () => {
  const keys = hapDir({ [KEYS]: '' });
  assert.throws(() => checkPairingFiles(keys, USERNAME), (error: Error) => {
    assert.match(error.message, /new pairing identity/);
    assert.ok(error.message.includes(`Restore ${keys} from a backup`), error.message);
    return true;
  });
  const ids = hapDir({ [KEYS]: GOOD_KEYS, 'IdentifierCache.0E1122334457.json': '' });
  assert.throws(() => checkPairingFiles(ids, USERNAME), (error: Error) => {
    assert.ok(error.message.includes(`The pairing is not affected (its keys are in ${KEYS})`), error.message);
    assert.match(error.message, /rooms and automations/);
    assert.ok(error.message.includes(`move it out of ${ids}`), error.message);
    assert.doesNotMatch(error.message, /delete|pair from scratch/);
    return true;
  });
  const camera = hapDir({ [KEYS]: GOOD_KEYS, 'ControllerStorage.0E1122334457.json': '{' });
  assert.throws(() => checkPairingFiles(camera, USERNAME), (error: Error) => {
    assert.ok(error.message.includes('The pairing is not affected'), error.message);
    assert.doesNotMatch(error.message, /rooms and automations|delete|pair from scratch/);
    return true;
  });
});

test('pairing files: only this bridge\'s files are checked, and only its AccessoryInfo must carry keys', () => {
  checkPairingFiles(hapDir({ [KEYS]: GOOD_KEYS, 'AccessoryInfo.0E0000000001.json': '{"displayName":"old bridge"}' }), USERNAME);
  checkPairingFiles(hapDir({ 'IdentifierCache.0E1122334457.json': '{"cache":{}}' }), USERNAME);
  // Another bridge's damaged file, and something that is not HAP-NodeJS's at all.
  checkPairingFiles(hapDir({ [KEYS]: GOOD_KEYS, 'IdentifierCache.0E0000000001.json': '', 'notes.txt': 'not json' }), USERNAME);
  // A renamed copy is not HAP-NodeJS's file, even with the same ending.
  checkPairingFiles(hapDir({ [KEYS]: GOOD_KEYS, [`backup.${KEYS}`]: '', 'old-IdentifierCache.0E1122334457.json': '{' }), USERNAME);
});

test('pairing files: links are followed', () => {
  const linked = hapDir({});
  writeFileSync(join(dir, `keys-${counter}.json`), GOOD_KEYS);
  symlinkSync(join(dir, `keys-${counter}.json`), join(linked, KEYS));
  checkPairingFiles(linked, USERNAME);

  const empty = hapDir({});
  writeFileSync(join(dir, `empty-${counter}.json`), '');
  symlinkSync(join(dir, `empty-${counter}.json`), join(empty, KEYS));
  assert.throws(() => checkPairingFiles(empty, USERNAME), (error: Error) => error.message.startsWith(`${join(empty, KEYS)} cannot be read (empty).`));

  const dangling = hapDir({});
  symlinkSync(join(dir, 'nowhere.json'), join(dangling, KEYS));
  assert.throws(() => checkPairingFiles(dangling, USERNAME), (error: Error) => error.message.startsWith(`${join(dangling, KEYS)} cannot be read (a link to nothing).`));
});

test('writeAtomically: a link is written through, and stays a link', () => {
  const folder = join(dir, 'atomic-link');
  mkdirSync(folder);
  writeFileSync(join(folder, 'real.json'), 'old');
  symlinkSync('real.json', join(folder, 'link.json'));
  writeAtomically(join(folder, 'link.json'), 'new');
  assert.ok(lstatSync(join(folder, 'link.json')).isSymbolicLink());
  assert.equal(readFileSync(join(folder, 'real.json'), 'utf8'), 'new');
  assert.deepEqual(readdirSync(folder).sort(), ['link.json', 'real.json']);
});

test('savePairingFile: an unchanged file is not written again', () => {
  const folder = join(dir, 'save-unchanged');
  mkdirSync(folder);
  const file = join(folder, KEYS);
  const write = fs.writeFileSync;
  let writes = 0;
  mock.method(fs, 'writeFileSync', (target: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
    writes++;
    return write(target, data as string, options);
  });
  syncBuiltinESMExports();
  try {
    savePairingFile(file, GOOD_KEYS); // new
    savePairingFile(file, GOOD_KEYS); // the same again: skipped
    savePairingFile(file, `${GOOD_KEYS} `); // changed
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(writes, 2);
  assert.equal(readFileSync(file, 'utf8'), `${GOOD_KEYS} `);
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

test('writeAtomically: each write has its own temporary file, created exclusively', () => {
  // Two processes saving to the same storage must not share a temporary file:
  // one could empty it just before the other renames it into place.
  const folder = join(dir, 'atomic-own');
  mkdirSync(folder);
  const write = fs.writeFileSync;
  const seen: Array<{ file: string; flag: unknown }> = [];
  mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
    seen.push({ file: String(file), flag: typeof options === 'object' && options !== null ? options.flag : undefined });
    return write(file, data as string, options);
  });
  syncBuiltinESMExports();
  try {
    writeAtomically(join(folder, 'file.json'), 'one');
    writeAtomically(join(folder, 'file.json'), 'two');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]?.file, seen[1]?.file);
  for (const { file, flag } of seen) {
    assert.ok(basename(file).startsWith('.file.json.'), file);
    assert.equal(flag, 'wx', file);
  }
  assert.deepEqual(readdirSync(folder), ['file.json']);
});

test('writeAtomically: a link to a file that does not exist yet creates the file and keeps the link', () => {
  const folder = join(dir, 'atomic-dangling');
  mkdirSync(folder);
  symlinkSync('real.json', join(folder, 'link.json'));
  writeAtomically(join(folder, 'link.json'), 'created');
  assert.ok(lstatSync(join(folder, 'link.json')).isSymbolicLink());
  assert.equal(readFileSync(join(folder, 'real.json'), 'utf8'), 'created');
});

test('writeAtomically: a temporary name that is taken is left to its owner', () => {
  const folder = join(dir, 'atomic-taken');
  mkdirSync(folder);
  const write = fs.writeFileSync;
  let taken = '';
  mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
    if (typeof file === 'string' && file.endsWith('.tmp')) {
      taken = file;
      write(file, 'another writer'); // got there first
      throw Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: 'EEXIST' });
    }
    return write(file, data as string, options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeAtomically(join(folder, 'file.json'), 'mine'), /EEXIST/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(taken, 'utf8'), 'another writer');
});
