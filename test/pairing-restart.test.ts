// A pairing has to survive a restart, now that bamboozle saves it rather than
// HAP-NodeJS's own writer: pair with an independent HomeKit controller,
// restart the bridge in a new process on a full disk (nothing needs saving,
// so it must come up), and log in again with the controller's long-term keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HttpClient } from 'hap-controller';

const storage = mkdtempSync(join(tmpdir(), 'bamboozle-restart-'));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(storage, { recursive: true, force: true });
});

const script = fileURLToPath(new URL('./support/bridge-process.ts', import.meta.url));
const fullDisk = fileURLToPath(new URL('./support/full-disk.ts', import.meta.url));

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

interface Started {
  child: ChildProcess;
  info: { username: string; pincode: string; paired: boolean };
}

function startProcess(port: number, preload: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Started> {
  const child = spawn(process.execPath, [...preload, script, storage, String(port)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', (line) => resolve({ child, info: JSON.parse(line) as Started['info'] }));
    child.once('exit', (code) => reject(new Error(`bridge exited (${code}) before it was published: ${stderr.trim()}`)));
  });
}

/** publish() starts listening without waiting for it: wait until the port takes connections. */
async function listening(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`nothing listening on ${port}`);
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

function signPk(username: string): string {
  const file = join(storage, 'hap', `AccessoryInfo.${username.replaceAll(':', '')}.json`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { signPk: string }).signPk;
}

test('a pairing survives a restart on a full disk', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const first = await startProcess(port);
  assert.equal(first.info.paired, false);
  await listening(port);
  const setup = new HttpClient(first.info.username, '127.0.0.1', port);
  await setup.pairSetup(first.info.pincode);
  const keys = setup.getLongTermData();
  assert.ok(keys, 'long-term keys from pair setup');
  await setup.close();
  await stopProcess(first.child);
  const pk = signPk(first.info.username);

  const secondPort = await freePort();
  const second = await startProcess(secondPort, ['--import', fullDisk], { BAMBOOZLE_FULL_DISK: storage });
  assert.equal(second.info.username, first.info.username);
  assert.equal(second.info.paired, true);
  await listening(secondPort);
  const verify = new HttpClient(second.info.username, '127.0.0.1', secondPort, keys);
  const db = (await verify.getAccessories()) as { accessories: unknown[] };
  assert.equal(db.accessories.length, 1, 'pair-verify with the saved keys, then the bridge itself');
  await verify.close();
  await stopProcess(second.child);
  assert.equal(signPk(first.info.username), pk);
});
