import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hap from '@homebridge/hap-nodejs';
import { Characteristic, Service } from '@homebridge/hap-nodejs';
import { ConfigError, loadConfig, parseConfig } from '../src/config.ts';
import { ResumeControl, RESUME_FAILURE_MS, RESUMED_HOLD_MS } from '../src/homekit/resume-control.ts';
import { STATUS_NOT_ALLOWED_IN_CURRENT_STATE, STATUS_RESOURCE_BUSY } from '../src/homekit/hap-constants.ts';
import { runResumeCommand } from '../src/resume.ts';
import type { PrinterStatus } from '../src/printer/status.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bamboozle-resume-'));
}

/** An executable shell script in `dir`; returns its path. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const paused = { state: 'paused' } as PrinterStatus;
const printing = { state: 'printing' } as PrinterStatus;

test('HAP status literals match the library', () => {
  assert.equal(STATUS_RESOURCE_BUSY, hap.HAPStatus.RESOURCE_BUSY);
  assert.equal(STATUS_NOT_ALLOWED_IN_CURRENT_STATE, hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
});

// --- config ----------------------------------------------------------------------

const printerWith = (extra: Record<string, unknown>) =>
  parseConfig({ printers: [{ name: 'P', host: '192.0.2.10', serial: 'AB1000000001', accessCode: '12345678', ...extra }] }, '/').printers[0]!;

test('config: resumeCommand is an argv array starting with an absolute path', () => {
  assert.deepEqual(printerWith({ resumeCommand: ['/usr/local/bin/resume-it', '--printer', 'left'] }).resumeCommand, ['/usr/local/bin/resume-it', '--printer', 'left']);
  assert.equal(printerWith({}).resumeCommand, undefined);
  for (const bad of ['/usr/local/bin/resume-it', [], ['resume-it'], ['./resume-it'], ['/bin/x', 3], ['/bin/x', ''], ['/bin/x', 'a\0b'], [' /bin/x']]) {
    assert.throws(() => printerWith({ resumeCommand: bad }), (error: unknown) => error instanceof ConfigError && /resumeCommand/.test(error.message), JSON.stringify(bad));
  }
});

// --- runner ----------------------------------------------------------------------

test('runner: exit 0 is accepted, its first output line is kept, the environment holds only the printer name and PATH', async () => {
  const dir = tempDir();
  try {
    process.env['BAMBOOZLE_TEST_SECRET'] = 'must-not-leak';
    const envFile = join(dir, 'env.txt');
    const ok = script(dir, 'ok', `env > ${envFile}\nprintf 'resumed %s \\001on  time\\nsecond line\\n' "$1"`);
    const result = await runResumeCommand([ok, 'left'], 'Left H2C');
    assert.equal(result.ok, true);
    assert.equal(result.message, 'resumed left on time');
    const env = readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')[0]).sort();
    assert.deepEqual(env.filter((key) => !['PWD', 'SHLVL', '_'].includes(key!)), ['BAMBOOZLE_PRINTER', 'PATH']);
    assert.match(readFileSync(envFile, 'utf8'), /^BAMBOOZLE_PRINTER=Left H2C$/m);
  } finally {
    delete process.env['BAMBOOZLE_TEST_SECRET'];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a non-zero exit, a missing program and a timeout all fail', async () => {
  const dir = tempDir();
  try {
    const refused = await runResumeCommand([script(dir, 'no', 'echo "not a resumable pause"; exit 3')], 'P');
    assert.deepEqual(refused, { ok: false, message: 'exit 3: not a resumable pause' });
    const missing = await runResumeCommand([join(dir, 'nothing')], 'P');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /ENOENT/);
    const started = Date.now();
    // The shell's own child (sleep) holds the output open: the whole group must go.
    const slow = await runResumeCommand([script(dir, 'slow', 'sleep 5; echo late')], 'P', { timeoutMs: 300 });
    assert.equal(slow.ok, false);
    assert.match(slow.message, /no answer within 0.3 s/);
    assert.ok(Date.now() - started < 3000, 'killed at the limit, not waited for');
    const long = await runResumeCommand([script(dir, 'long', `printf '%0500d\\n' 0`)], 'P');
    assert.ok(long.message.length <= 200, 'logged output is cut short');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: an abort kills the running command', async () => {
  const dir = tempDir();
  try {
    const abort = new AbortController();
    const run = runResumeCommand([script(dir, 'slow', 'sleep 5')], 'P', { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const started = Date.now();
    const result = await run;
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the Home control -------------------------------------------------------------

function control(run: (argv: readonly string[], name: string, options: { signal?: AbortSignal }) => Promise<{ ok: boolean; message: string }>) {
  const lines: string[] = [];
  const resume = new ResumeControl({
    name: 'Left',
    serial: 'AB1000000001',
    command: ['/usr/local/bin/resume-it'],
    log: { log: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`) },
    run,
  });
  const on = resume.accessory.getService(Service.Switch)!.getCharacteristic(Characteristic.On);
  return { resume, on, lines };
}

async function rejects(promise: Promise<unknown>, status: number): Promise<void> {
  // hap-nodejs rejects a request with the bare HAP status number.
  await assert.rejects(promise, (error: unknown) => error === status);
}

test('control: ON while paused runs the command once; the switch shows the run and settles off', async () => {
  let release!: (result: { ok: boolean; message: string }) => void;
  const calls: Array<{ argv: readonly string[]; name: string }> = [];
  const { resume, on, lines } = control((argv, name) => {
    calls.push({ argv, name });
    return new Promise((resolve) => (release = resolve));
  });
  resume.update(paused, true);
  assert.equal(await on.handleGetRequest(), false);
  await on.handleSetRequest(true);
  assert.deepEqual(calls, [{ argv: ['/usr/local/bin/resume-it'], name: 'Left' }]);
  assert.equal(await on.handleGetRequest(), true, 'on while the command runs');
  // A second press while it runs starts nothing.
  await rejects(on.handleSetRequest(true), STATUS_RESOURCE_BUSY);
  assert.equal(calls.length, 1);
  release({ ok: true, message: 'resumed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await on.handleGetRequest(), false);
  assert.ok(lines.some((line) => /resume accepted: resumed/.test(line)), lines.join('\n'));
  await resume.stop();
});

test('control: ON while not paused, or while the printer is unreachable, is refused and runs nothing', async () => {
  const calls: string[] = [];
  const { resume, on } = control(async (_argv, name) => {
    calls.push(name);
    return { ok: true, message: '' };
  });
  for (const status of [printing, { state: 'idle' } as PrinterStatus, { state: 'failed' } as PrinterStatus]) {
    resume.update(status, true);
    await rejects(on.handleSetRequest(true), STATUS_NOT_ALLOWED_IN_CURRENT_STATE);
  }
  resume.update(null, false);
  await rejects(on.handleSetRequest(true), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  await rejects(on.handleGetRequest(), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  resume.update(paused, false);
  await rejects(on.handleSetRequest(true), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.deepEqual(calls, []);
  await resume.stop();
});

test('control: OFF (a "turn everything off" scene) does nothing', async () => {
  const calls: string[] = [];
  const { resume, on } = control(async (_argv, name) => {
    calls.push(name);
    return { ok: true, message: '' };
  });
  resume.update(paused, true);
  await on.handleSetRequest(false);
  await on.handleSetRequest(0);
  assert.deepEqual(calls, []);
  assert.equal(await on.handleGetRequest(), false);
  await resume.stop();
});

test('control: a failed run shows No Response for a while, then the switch is off again', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { resume, on, lines } = control(async () => ({ ok: false, message: 'exit 3: not a resumable pause' }));
  resume.update(paused, true);
  await on.handleSetRequest(true);
  await new Promise((resolve) => setImmediate(resolve));
  await rejects(on.handleGetRequest(), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  // Printer reports keep arriving; they do not hide the failure.
  resume.update(paused, true);
  await rejects(on.handleGetRequest(), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.ok(lines.some((line) => /^WARN \[Left\] resume failed: exit 3: not a resumable pause$/.test(line)), lines.join('\n'));
  t.mock.timers.tick(RESUME_FAILURE_MS);
  assert.equal(await on.handleGetRequest(), false);
  await resume.stop();
});

test('control: stop() aborts a running command', async () => {
  let aborted = false;
  const { resume, on } = control((_argv, _name, options) => new Promise((resolve) => {
    options.signal?.addEventListener('abort', () => {
      aborted = true;
      resolve({ ok: false, message: 'aborted' });
    });
  }));
  resume.update(paused, true);
  await on.handleSetRequest(true);
  await resume.stop();
  assert.equal(aborted, true);
});

test('runner: 30 s is a hard bound, even when the command leaves something holding its output', async () => {
  const dir = tempDir();
  try {
    // setsid: a new session, out of reach of the group kill, keeping stdout open.
    let started = Date.now();
    const stuck = await runResumeCommand([script(dir, 'stuck', 'setsid sleep 3 &\nsleep 3')], 'P', { timeoutMs: 300 });
    assert.equal(stuck.ok, false);
    assert.ok(Date.now() - started < 1500, `settled after ${Date.now() - started} ms`);
    started = Date.now();
    // The pause lets setsid start before the command exits, so the grace path is what settles it.
    const left = await runResumeCommand([script(dir, 'left', 'setsid sleep 3 &\nsleep 0.3\necho resumed')], 'P');
    assert.deepEqual(left, { ok: true, message: 'resumed' });
    assert.ok(Date.now() - started < 2500, `settled after ${Date.now() - started} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: the command runs in /', async () => {
  const dir = tempDir();
  try {
    const result = await runResumeCommand([script(dir, 'where', 'pwd')], 'P');
    assert.deepEqual(result, { ok: true, message: '/' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: right after an accepted resume, a second press waits for the printer to leave the pause', async () => {
  let runs = 0;
  const { resume, on } = control(async () => {
    runs++;
    return { ok: true, message: 'resumed' };
  });
  resume.update(paused, true);
  await on.handleSetRequest(true);
  await new Promise((resolve) => setImmediate(resolve));
  // The printer has not reported the resume yet: a double tap must not run it again.
  await rejects(on.handleSetRequest(true), STATUS_RESOURCE_BUSY);
  resume.update(printing, true);
  resume.update(paused, true);
  await on.handleSetRequest(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
  await resume.stop();
});

test('control: stopping bamboozle during a run is not reported as a failed resume', async () => {
  const { resume, on, lines } = control((_argv, _name, options) => new Promise((resolve) => {
    options.signal?.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' }));
  }));
  resume.update(paused, true);
  await on.handleSetRequest(true);
  await resume.stop();
  assert.ok(!lines.some((line) => line.startsWith('WARN')), lines.join('\n'));
});

test('init --force keeps the resumeCommand of the same printer', async () => {
  const { init } = await import('../src/init.ts');
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    const command = ['/usr/local/bin/resume-it', '--printer', 'left'];
    writeFileSync(configPath, JSON.stringify({ printers: [{ name: 'Left', host: '192.0.2.10', serial: '01P00A000000000', accessCode: 'oldcode1', resumeCommand: command }] }));
    const answers = ['192.0.2.10', '12345678', '', ''];
    const io = {
      ask: async () => answers.shift() ?? '',
      say: () => {},
      readSerial: async () => '01P00A000000000',
      probe: async () => ({ ok: true as const, summary: 'idle' }),
    };
    assert.equal(await init({ configPath, force: true, serveCommand: 'bamboozle serve' }, io), 0);
    assert.deepEqual(loadConfig(configPath).printers[0]?.resumeCommand, command);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: the hold after an accepted resume survives a reconnect, and a resume the printer already showed sets none', async () => {
  let release!: (result: { ok: boolean; message: string }) => void;
  let runs = 0;
  const { resume, on } = control(() => {
    runs++;
    return new Promise((resolve) => (release = resolve));
  });
  resume.update(paused, true);
  await on.handleSetRequest(true);
  release({ ok: true, message: '' });
  await new Promise((resolve) => setImmediate(resolve));
  // Connection lost and back, the printer still says paused: no second resume.
  // Partial reports before the first full one (unavailable) do not count either.
  resume.update(null, false);
  resume.update({ state: 'unknown' } as PrinterStatus, false);
  resume.update(printing, false);
  resume.update(paused, true);
  await rejects(on.handleSetRequest(true), STATUS_RESOURCE_BUSY);
  // A state bamboozle does not know (unknown) says nothing about the pause either.
  resume.update({ state: 'unknown' } as PrinterStatus, true);
  resume.update(paused, true);
  await rejects(on.handleSetRequest(true), STATUS_RESOURCE_BUSY);
  // It prints, then pauses again: that new pause can be resumed.
  resume.update(printing, true);
  resume.update(paused, true);
  await on.handleSetRequest(true);
  // This time the printer reports printing before the command even answers ...
  resume.update(printing, true);
  release({ ok: true, message: '' });
  await new Promise((resolve) => setImmediate(resolve));
  // ... so a pause after that is a new one, free to resume.
  resume.update(paused, true);
  await on.handleSetRequest(true);
  assert.equal(runs, 3);
  release({ ok: true, message: '' });
  await resume.stop();
});

test('control: the hold after an accepted resume ends after a minute even if the printer keeps saying paused', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let runs = 0;
  const { resume, on } = control(async () => {
    runs++;
    return { ok: true, message: '' };
  });
  resume.update(paused, true);
  await on.handleSetRequest(true);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(RESUMED_HOLD_MS - 1);
  await rejects(on.handleSetRequest(true), STATUS_RESOURCE_BUSY);
  t.mock.timers.tick(1);
  await on.handleSetRequest(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
  await resume.stop();
});

test('runner: a command that exits 0 just before the limit, output still held open, is accepted', async () => {
  const dir = tempDir();
  try {
    const result = await runResumeCommand([script(dir, 'late', 'setsid sleep 3 &\nsleep 0.6\necho resumed')], 'P', { timeoutMs: 1000 });
    assert.deepEqual(result, { ok: true, message: 'resumed' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('control: an unknown state while the command runs does not count as leaving the pause', async () => {
  let release!: (result: { ok: boolean; message: string }) => void;
  const { resume, on } = control(() => new Promise((resolve) => (release = resolve)));
  resume.update(paused, true);
  await on.handleSetRequest(true);
  resume.update({ state: 'unknown' } as PrinterStatus, true);
  release({ ok: true, message: '' });
  await new Promise((resolve) => setImmediate(resolve));
  resume.update(paused, true);
  await rejects(on.handleSetRequest(true), STATUS_RESOURCE_BUSY);
  await resume.stop();
});
