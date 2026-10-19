import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { defaultConfigPath, openAdvice, openToEveryone, resolveConfigPath } from '../src/paths.ts';

const home = () => '/home/someone';

test('--config wins over BAMBOOZLE_CONFIG, which wins over the default', () => {
  const env = { BAMBOOZLE_CONFIG: '/etc/bamboozle.json', XDG_CONFIG_HOME: '/xdg' };
  assert.equal(resolveConfigPath('/tmp/c.json', env, home), '/tmp/c.json');
  assert.equal(resolveConfigPath(undefined, env, home), '/etc/bamboozle.json');
  assert.equal(resolveConfigPath(undefined, { XDG_CONFIG_HOME: '/xdg' }, home), '/xdg/bamboozle/config.json');
  assert.equal(resolveConfigPath(undefined, {}, home), '/home/someone/.config/bamboozle/config.json');
});

test('degenerate inputs: empty flag refused, blank env ignored, relative XDG ignored, no home refused', () => {
  assert.throws(() => resolveConfigPath('', {}, home), /--config needs a file path/);
  assert.throws(() => resolveConfigPath('   ', {}, home), /--config needs a file path/);
  assert.equal(resolveConfigPath(undefined, { BAMBOOZLE_CONFIG: '  ' }, home), '/home/someone/.config/bamboozle/config.json');
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: 'relative/dir' }, home), '/home/someone/.config/bamboozle/config.json');
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: ' ' }, home), '/home/someone/.config/bamboozle/config.json');
  assert.throws(() => defaultConfigPath({}, () => ''), /cannot find your home directory/);
  // An absolute XDG_CONFIG_HOME does not need a home directory at all.
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: '/xdg' }, () => ''), '/xdg/bamboozle/config.json');
});

test('openToEveryone finds a directory on the way up that others could use to swap what is below', () => {
  const base = mkdtempSync(join(tmpdir(), 'bamboozle-paths-')); // 0700, under a sticky /tmp
  after(() => rmSync(base, { recursive: true, force: true }));
  const open = join(base, 'open');
  const inner = join(open, 'inner');
  mkdirSync(inner, { recursive: true });
  chmodSync(inner, 0o700);
  assert.equal(openToEveryone(inner), null, 'nothing open yet');
  chmodSync(open, 0o777);
  assert.equal(openToEveryone(inner), open, 'a private directory inside an open one can be swapped out');
  assert.equal(openToEveryone(join(inner, 'not', 'there', 'yet')), open, 'a path to be created is judged by what exists');
  chmodSync(open, 0o1777);
  assert.equal(openToEveryone(inner), null, 'sticky above an existing directory, like /tmp: fine');
  assert.equal(openToEveryone(join(open, 'not-yet')), open, 'but not where something is still to be created: sticky does not stop others creating that name first');
  assert.equal(openToEveryone(join(open, 'not-yet'), 'win32'), null, 'Windows reports every directory as writable: no check');
  chmodSync(open, 0o775);
  assert.equal(openToEveryone(inner), null, 'group-writable is allowed (umask 002)');
});

test('openToEveryone follows a symlink: what lies above its target counts too', () => {
  const base = mkdtempSync(join(tmpdir(), 'bamboozle-paths-'));
  after(() => rmSync(base, { recursive: true, force: true }));
  const shared = join(base, 'shared');
  const safe = join(base, 'safe');
  mkdirSync(join(shared, 'state'), { recursive: true });
  mkdirSync(join(safe, 'state'), { recursive: true });
  chmodSync(join(shared, 'state'), 0o700);
  mkdirSync(join(base, 'private'), { mode: 0o700 });
  symlinkSync(join(shared, 'state'), join(base, 'private', 'state'));
  symlinkSync(join(safe, 'state'), join(base, 'private', 'fine'));
  chmodSync(shared, 0o777);
  assert.equal(openToEveryone(join(base, 'private', 'state')), shared, 'the link target sits in an open directory');
  assert.equal(openToEveryone(join(base, 'private', 'state', 'to-create')), shared, 'and so does anything still to be created below it');
  assert.equal(openToEveryone(join(base, 'private', 'fine')), null, 'a link to a private place is fine');
});

test('the advice for an open directory never says to chmod a sticky one such as /tmp', () => {
  const base = mkdtempSync(join(tmpdir(), 'bamboozle-paths-'));
  after(() => rmSync(base, { recursive: true, force: true }));
  const mine = join(base, 'mine');
  mkdirSync(mine);
  chmodSync(mine, 0o777);
  assert.match(openAdvice(mine, mine), /chmod 700/, 'my own open directory: close it');
  chmodSync(mine, 0o1777);
  const advice = openAdvice(mine, join(mine, 'bz', 'storage'));
  assert.doesNotMatch(advice, /chmod/, 'sticky (think /tmp): never chmod it');
  assert.ok(advice.includes(`mkdir -m 700 ${join(mine, 'bz')}`), advice);
  assert.match(openAdvice(mine, mine), /--config/, 'nothing to create below it: go elsewhere');
});

test('openToEveryone checks every directory a lookup passes, intermediate links in a chain included', () => {
  const base = mkdtempSync(join(tmpdir(), 'bamboozle-paths-'));
  after(() => rmSync(base, { recursive: true, force: true }));
  for (const dir of ['private', 'shared', 'real/state']) mkdirSync(join(base, dir), { recursive: true, mode: 0o700 });
  symlinkSync(join(base, 'shared', 'middle'), join(base, 'private', 'state')); // private/state -> shared/middle
  symlinkSync(join(base, 'real', 'state'), join(base, 'shared', 'middle')); // shared/middle -> real/state
  symlinkSync('../real/state', join(base, 'private', 'relative')); // a relative target
  symlinkSync(join(base, 'private', 'loop-b'), join(base, 'private', 'loop-a'));
  symlinkSync(join(base, 'private', 'loop-a'), join(base, 'private', 'loop-b'));
  assert.equal(openToEveryone(join(base, 'private', 'state')), null, 'all private so far');
  assert.equal(openToEveryone(join(base, 'private', 'relative', 'config.json')), null);
  chmodSync(join(base, 'shared'), 0o777);
  assert.equal(openToEveryone(join(base, 'private', 'state')), join(base, 'shared'), 'the middle link can be swapped');
  assert.equal(openToEveryone(join(base, 'private', 'state', 'storage')), join(base, 'shared'));
  assert.equal(openToEveryone(join(base, 'private', 'loop-a', 'x')), null, 'a loop ends the walk (the read itself fails later)');
});
