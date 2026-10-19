// A pairing file that exists but cannot be read (cut short when the disk
// filled up, say) must stop the bridge. HAP-NodeJS would otherwise quietly
// create a new pairing identity under the same name, and the Home app would
// show the bridge as not responding until it is removed and added again.
// Own file: HAP-NodeJS keeps one storage location per process.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, type RunningBridge } from '../src/homekit/bridge.ts';

const dir = mkdtempSync(join(tmpdir(), 'bamboozle-truncated-'));
let bridge: RunningBridge | undefined;
after(async () => {
  await bridge?.stop();
  rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

test('an empty pairing file stops the bridge instead of creating a new identity', async () => {
  const storage = join(dir, 'storage');
  const hap = join(storage, 'hap');
  mkdirSync(hap, { recursive: true });
  writeFileSync(join(storage, 'bridge.json'), JSON.stringify({ username: '0E:11:22:33:44:55', pincode: '031-45-154', setupID: 'TS01' }));
  const info = join(hap, 'AccessoryInfo.0E1122334455.json');
  writeFileSync(info, '');

  const port = await freePort();
  await assert.rejects(
    async () => {
      bridge = await startBridge({ name: 'bamboozle test', port, bind: ['127.0.0.1'], storagePath: storage }, []);
    },
    (error: Error) => {
      assert.match(error.message, /AccessoryInfo\.0E1122334455\.json cannot be read \(empty\)/);
      assert.match(error.message, /from a backup/);
      return true;
    },
  );
  // Nothing rewritten, nothing new: the file stays as found, for the restore.
  assert.equal(statSync(info).size, 0);
  assert.deepEqual(readdirSync(hap), ['AccessoryInfo.0E1122334455.json']);
});
