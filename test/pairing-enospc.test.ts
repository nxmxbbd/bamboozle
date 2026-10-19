// A full disk while the pairing keys are saved must leave the saved keys
// intact. HAP-NodeJS saves them on every start, and a plain write empties the
// file before it fails: the next start then found no keys, made new ones, and
// the Home app lost the bridge. The kernel's behaviour is reproduced here: the
// write empties its target, then fails with ENOSPC.
// Own file: HAP-NodeJS keeps one storage location per process.

import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, type RunningBridge } from '../src/homekit/bridge.ts';

const dir = mkdtempSync(join(tmpdir(), 'bamboozle-enospc-'));
let bridge: RunningBridge | undefined;
after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
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

/** Pairing keys as HAP-NodeJS stores them: Ed25519 secret key = seed + public key. */
function savedAccessoryInfo(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return JSON.stringify({
    displayName: 'bamboozle test 0000',
    category: 2,
    pincode: '031-45-154',
    signSk: Buffer.concat([seed, pk]).toString('hex'),
    signPk: pk.toString('hex'),
    pairedClients: {},
    pairedClientsPermission: {},
    configVersion: 1,
    configHash: '',
    setupID: 'TS01',
    lastFirmwareVersion: '',
  });
}

test('a full disk while saving the pairing keys leaves the saved keys untouched', async () => {
  const storage = join(dir, 'storage');
  const hap = join(storage, 'hap');
  mkdirSync(hap, { recursive: true });
  writeFileSync(join(storage, 'bridge.json'), JSON.stringify({ username: '0E:11:22:33:44:56', pincode: '031-45-154', setupID: 'TS01' }));
  const info = join(hap, 'AccessoryInfo.0E1122334456.json');
  const saved = savedAccessoryInfo();
  writeFileSync(info, saved);

  const write = fs.writeFileSync;
  mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: unknown, options?: fs.WriteFileOptions) => {
    if (typeof file === 'string' && file.startsWith(storage)) {
      write(file, '');
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
    }
    return write(file, data as string, options);
  });
  syncBuiltinESMExports();

  const port = await freePort();
  try {
    await assert.rejects(async () => {
      bridge = await startBridge({ name: 'bamboozle test', port, bind: ['127.0.0.1'], storagePath: storage }, []);
    }, /ENOSPC/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(info, 'utf8'), saved);
  assert.deepEqual(readdirSync(hap), ['AccessoryInfo.0E1122334456.json']);
});
