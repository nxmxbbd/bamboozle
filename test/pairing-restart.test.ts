// A pairing has to survive restarts, including one on a full disk: pair with
// an independent HomeKit controller, try to restart the bridge in a new
// process while every write fails as on a full disk (HAP-NodeJS saves its
// pairing on every start, so it must stop without touching the saved keys),
// then restart it with space again and log in with the controller's
// long-term keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HttpClient } from 'hap-controller';

// realpath: the full-disk preload matches paths as written (macOS's tmpdir is behind a link).
const storage = realpathSync(mkdtempSync(join(tmpdir(), 'bamboozle-restart-')));
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

function keysFile(username: string): string {
  return readFileSync(join(storage, 'hap', `AccessoryInfo.${username.replaceAll(':', '')}.json`), 'utf8');
}

test('a pairing survives a restart, and a restart on a full disk leaves it alone', { timeout: 60_000 }, async () => {
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
  const saved = keysFile(first.info.username);
  assert.equal(Object.keys((JSON.parse(saved) as { pairedClients: object }).pairedClients).length, 1);

  await assert.rejects(startProcess(await freePort(), ['--import', fullDisk], { BAMBOOZLE_FULL_DISK: storage }), /ENOSPC/);
  assert.equal(keysFile(first.info.username), saved, 'the saved keys are untouched');
  assert.deepEqual(readdirSync(join(storage, 'hap')).filter((name) => name.startsWith('.')), [], 'no temporary file left');

  const thirdPort = await freePort();
  const third = await startProcess(thirdPort);
  assert.equal(third.info.username, first.info.username);
  assert.equal(third.info.paired, true);
  await listening(thirdPort);
  const verify = new HttpClient(third.info.username, '127.0.0.1', thirdPort, keys);
  const db = (await verify.getAccessories()) as { accessories: unknown[] };
  assert.equal(db.accessories.length, 1, 'pair-verify with the saved keys, then the bridge itself');
  await verify.close();
  await stopProcess(third.child);
  assert.equal(JSON.parse(keysFile(first.info.username)).signPk, JSON.parse(saved).signPk);
});
