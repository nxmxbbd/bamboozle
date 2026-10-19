import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfigPath, resolveConfigPath } from '../src/paths.ts';

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
