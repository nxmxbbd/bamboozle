import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { defaultConfigPath, openToEveryone, resolveConfigPath } from '../src/paths.ts';

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
