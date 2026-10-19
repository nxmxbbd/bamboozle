import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface LockPackage {
  optional?: boolean;
  dev?: boolean;
}

/** Optional packages that are not dev ones: .npmrc would skip what the bridge needs to run. */
function optionalRuntimePackages(lock: { packages: Record<string, LockPackage> }): string[] {
  return Object.entries(lock.packages)
    .filter(([name, entry]) => name !== '' && entry.optional === true && entry.dev !== true)
    .map(([name]) => name);
}

// .npmrc has omit=optional: every optional package today is one of
// hap-controller's Bluetooth, serial or USB transports, used by nothing.
// That stays safe only while no package the bridge needs is optional.
test('no optional package in the lock file is needed at run time', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, LockPackage> };
  assert.match(readFileSync(new URL('../.npmrc', import.meta.url), 'utf8'), /^omit=optional$/m);
  assert.deepEqual(optionalRuntimePackages(lock), []);
  // And the check would notice one.
  assert.deepEqual(optionalRuntimePackages({ packages: { '': {}, 'node_modules/x': { optional: true } } }), ['node_modules/x']);
});
