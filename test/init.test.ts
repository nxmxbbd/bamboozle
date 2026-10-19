import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:tls';
import { loadConfig } from '../src/config.ts';
import { ACCESS_CODE_FILE, init, type InitIO, type InitOptions } from '../src/init.ts';
import { pairingLines, pairingQr } from '../src/homekit/pairing.ts';
import { readPrinterSerial } from '../src/printer/serial.ts';

const dir = mkdtempSync(join(tmpdir(), 'bamboozle-init-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

interface Fake {
  io: InitIO;
  said: string[];
  asked: string[];
}

/** Answers are consumed in order; readSerial / probe outcomes are configurable. */
function fakeIO(answers: string[], opts: { serial?: string | Error; probe?: { ok: true; summary: string } | { ok: false; error: string } } = {}): Fake {
  const said: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    said,
    asked,
    io: {
      ask: async (question, hidden) => {
        asked.push(`${hidden ? '(hidden) ' : ''}${question}`);
        return queue.shift() ?? '';
      },
      say: (line) => void said.push(line),
      readSerial: async () => {
        const serial = opts.serial ?? '01P00A000000000';
        if (serial instanceof Error) throw serial;
        return serial;
      },
      probe: async () => opts.probe ?? { ok: true, summary: 'idle' },
    },
  };
}

function options(overrides: Partial<InitOptions> = {}): InitOptions {
  n++;
  return { configPath: join(dir, `case-${n}`, 'bamboozle', 'config.json'), force: false, serveCommand: 'bamboozle serve', ...overrides };
}

const mode = (path: string) => statSync(path).mode & 0o777;

test('init writes a config the real loader accepts, with the code in a 0600 file next to it', async () => {
  const opts = options();
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', 'Workshop', '']);
  assert.equal(await init(opts, io), 0);
  const codeFile = join(opts.configPath, '..', ACCESS_CODE_FILE);
  assert.equal(readFileSync(codeFile, 'utf8'), '12345678\n');
  assert.equal(mode(opts.configPath), 0o600);
  assert.equal(mode(codeFile), 0o600);
  assert.ok(!readFileSync(opts.configPath, 'utf8').includes('12345678'), 'the code is not in the config');
  const config = loadConfig(opts.configPath);
  assert.equal(config.printers[0]?.host, '192.0.2.10');
  assert.equal(config.printers[0]?.serial, '01P00A000000000');
  assert.equal(config.printers[0]?.name, 'Workshop');
  assert.equal(config.printers[0]?.accessCode, '12345678');
  assert.equal(config.printers[0]?.cameraSource, undefined, 'no camera when left empty');
  assert.ok(asked.some((q) => q.startsWith('(hidden) LAN access code')), 'the access code is asked hidden');
  assert.ok(said.some((l) => l.includes('Next: run "bamboozle serve"')));
});

test('init stops before asking anything when it cannot write the config directory', async () => {
  // A regular file where the directory should be: mkdir fails even for root,
  // like a root-owned bind mount does for an unprivileged container user.
  const blocker = join(dir, `blocker-${++n}`);
  writeFileSync(blocker, '');
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init(options({ configPath: join(blocker, 'bamboozle', 'config.json') }), io), 1);
  assert.deepEqual(asked, [], 'nothing was asked');
  assert.ok(said.some((l) => l.includes(join(blocker, 'bamboozle')) && l.includes('ENOTDIR')), said.join('\n'));
});

test('init refuses a config directory every user can write to, unless it is sticky', async () => {
  const run = async (mode: number) => {
    const opts = options();
    const configDir = join(opts.configPath, '..');
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, mode);
    const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
    return { code: await init(opts, io), said, asked };
  };
  const open = await run(0o777);
  assert.equal(open.code, 1);
  assert.deepEqual(open.asked, [], 'nothing was asked');
  assert.ok(open.said.some((l) => l.includes('writable by every user')), open.said.join('\n'));
  assert.equal((await run(0o1777)).code, 0, 'sticky, like /tmp: others cannot replace our files');
  assert.equal((await run(0o775)).code, 0, 'group-writable, as mkdir makes it under a 002 umask');
});

test('init leaves an existing config (and its pairing) alone unless forced', async () => {
  const opts = options();
  const configDir = join(opts.configPath, '..');
  mkdirSync(join(configDir, 'storage'), { recursive: true });
  writeFileSync(opts.configPath, '{"keep": true}\n');
  writeFileSync(join(configDir, 'storage', 'bridge.json'), 'identity');

  const refused = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init(opts, refused.io), 1);
  assert.equal(readFileSync(opts.configPath, 'utf8'), '{"keep": true}\n');
  assert.equal(refused.asked.length, 0, 'nothing is asked');

  const forced = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, forced.io), 0);
  assert.equal(loadConfig(opts.configPath).printers[0]?.name, '3D Printer');
  assert.equal(readFileSync(join(configDir, 'storage', 'bridge.json'), 'utf8'), 'identity', 'the pairing survives --force');
});

test('init --force replaces the printer and keeps the rest of the config, a custom storagePath included', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  writeFileSync(opts.configPath, JSON.stringify({
    printers: [{ name: 'Old', host: '192.0.2.99', serial: '01P00A000000009', accessCode: 'oldcode1' }],
    storagePath: 'paired-state',
    bridge: { name: 'Workshop bridge', port: 51900 },
    display: { progress: ['window'] },
  }));
  const { io } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 0);
  const config = loadConfig(opts.configPath);
  assert.equal(config.storagePath, join(opts.configPath, '..', 'paired-state'), 'the pairing location is kept');
  assert.deepEqual([config.bridge.name, config.bridge.port], ['Workshop bridge', 51900]);
  assert.deepEqual(config.display.progress, ['window']);
  assert.equal(config.printers.length, 1);
  assert.equal(config.printers[0]?.host, '192.0.2.10');
  assert.equal(config.printers[0]?.accessCode, '12345678');
  assert.ok(!readFileSync(opts.configPath, 'utf8').includes('oldcode1'), 'the old inline code is gone');
});

test('init --force starts from scratch when the old config is not JSON', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  writeFileSync(opts.configPath, '{ broken');
  const { io, said } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 0);
  assert.equal(loadConfig(opts.configPath).printers[0]?.host, '192.0.2.10');
  assert.ok(said.some((l) => l.includes('not valid JSON')), said.join('\n'));
});

test('init falls back to asking for the serial, and re-asks empty required answers', async () => {
  const opts = options();
  const { io, said } = fakeIO(['', '192.0.2.10', '12345678', '01p00a000000001', '', ''], { serial: new Error('connection refused') });
  assert.equal(await init(opts, io), 0);
  assert.ok(said.includes('This one is needed.'));
  assert.ok(said.some((l) => l.includes('connection refused')));
  assert.equal(loadConfig(opts.configPath).printers[0]?.serial, '01P00A000000001', 'upper-cased');
});

test('init gives up on a required answer after three empty tries, writing nothing', async () => {
  const opts = options();
  await assert.rejects(init(opts, fakeIO(['', '', '']).io), /no answer to: Printer IP address/);
  assert.ok(!existsSync(opts.configPath));
});

test('init refuses a camera URL with credentials and writes nothing', async () => {
  const opts = options();
  const { io, said } = fakeIO(['192.0.2.10', '12345678', '', 'rtsps://bblp:12345678@192.0.2.10:322/streaming/live/1']);
  assert.equal(await init(opts, io), 1);
  assert.ok(said.some((l) => /credentials in the URL/.test(l) && l.includes('Nothing was written')));
  assert.ok(!existsSync(join(opts.configPath, '..')), 'not even the directory');
});

test('init keeps the files but fails when the probe gets no status', async () => {
  const opts = options({ host: '192.0.2.10', name: 'P', camera: 'rtsp://127.0.0.1:8554/printer' });
  const { io, said, asked } = fakeIO(['12345678'], { probe: { ok: false, error: 'connect ECONNREFUSED' } });
  assert.equal(await init(opts, io), 1);
  assert.equal(asked.length, 1, 'only the access code is asked when the rest is given');
  assert.ok(said.some((l) => l.includes('ECONNREFUSED')));
  assert.equal(loadConfig(opts.configPath).printers[0]?.cameraSource, 'rtsp://127.0.0.1:8554/printer');
});

// --- reading the serial from the certificate ------------------------------------

let hasOpenssl = true;
const certs: Record<string, { key: string; cert: string }> = {};
before(() => {
  try {
    for (const cn of ['01P00A000000002', 'not a serial']) {
      const key = join(dir, `${n}-${cn.length}.key`);
      const crt = join(dir, `${n}-${cn.length}.crt`);
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', key, '-out', crt, '-days', '1', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
      certs[cn] = { key: readFileSync(key, 'utf8'), cert: readFileSync(crt, 'utf8') };
    }
  } catch {
    hasOpenssl = false;
  }
});

function tlsServer(identity: { key: string; cert: string }): Promise<{ server: Server; port: number; bytes: () => number }> {
  let bytes = 0;
  const server = createServer(identity, (socket) => {
    socket.on('data', (chunk: Buffer) => (bytes += chunk.length));
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ server, port: typeof address === 'object' && address ? address.port : 0, bytes: () => bytes });
  }));
}

test('the serial is the common name of the printer certificate, and nothing is sent', async (t) => {
  if (!hasOpenssl) return t.skip('openssl not available');
  const { server, port, bytes } = await tlsServer(certs['01P00A000000002']!);
  try {
    assert.equal(await readPrinterSerial('127.0.0.1', port), '01P00A000000002');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bytes(), 0, 'no application data');
  } finally {
    server.close();
  }
});

test('a certificate that does not name a serial is refused, and so is a dead port', async (t) => {
  if (!hasOpenssl) return t.skip('openssl not available');
  const { server, port } = await tlsServer(certs['not a serial']!);
  try {
    await assert.rejects(readPrinterSerial('127.0.0.1', port), /does not name a printer serial/);
  } finally {
    server.close();
  }
  await assert.rejects(readPrinterSerial('127.0.0.1', port, 2000));
});

// --- pairing output ----------------------------------------------------------------

test('the pairing output has the code, a QR code and the URI, for terminals and for logs', () => {
  const uri = 'X-HM://0012ABCDEFGH';
  for (const tty of [true, false]) {
    const [intro, qr, tail] = pairingLines('bamboozle', '031-45-154', uri, tty);
    assert.match(intro ?? '', /scan this code with the iPhone camera/);
    assert.match(intro ?? '', /031-45-154/);
    assert.equal(tail, `setup URI: ${uri}`);
    assert.ok((qr ?? '').split('\n').length > 8, 'a QR code is several lines tall');
    assert.equal(qr, pairingQr(uri, tty));
  }
  assert.match(pairingQr(uri, true), /\x1b\[/, 'terminals get explicit colours');
  assert.doesNotMatch(pairingQr(uri, false), /\x1b\[/, 'logs get no escape codes');
});

// --- the terminal prompt -------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { promptLine, serveHint } from '../src/init.ts';

function fakeTty() {
  const events = new EventEmitter();
  const state = { raw: false, rawHistory: [] as boolean[] };
  const input = {
    setRawMode: (mode: boolean) => { state.raw = mode; state.rawHistory.push(mode); },
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    on: (event: 'data', listener: (chunk: string) => void) => events.on(event, listener),
    off: (event: 'data', listener: (chunk: string) => void) => events.off(event, listener),
  };
  let written = '';
  const output = { write: (text: string) => { written += text; } };
  return { input, output, type: (text: string) => events.emit('data', text), written: () => written, state };
}

test('a hidden answer is never echoed; the prompt and a newline are', async () => {
  const t = fakeTty();
  const answer = promptLine(t.input, t.output, 'Code: ', true);
  t.type('s3cr');
  t.type('3t\r');
  assert.equal(await answer, 's3cr3t');
  assert.equal(t.written(), 'Code: \n');
  assert.deepEqual(t.state.rawHistory, [true, false], 'raw mode is switched back off');
});

test('a visible answer is echoed; backspace edits; arrow keys are ignored', async () => {
  const t = fakeTty();
  const answer = promptLine(t.input, t.output, 'IP: ', false);
  t.type('192.0.2.1x\u007f0\u001b[D\u001bOA\r');
  assert.equal(await answer, '192.0.2.10');
  assert.equal(t.written(), 'IP: 192.0.2.1x\b \b0\n');
  const hidden = fakeTty();
  const code = promptLine(hidden.input, hidden.output, 'Code: ', true);
  hidden.type('ab\u007fc\r');
  assert.equal(await code, 'ac');
  assert.equal(hidden.written(), 'Code: \n', 'no backspace echo either');
});

test('Ctrl+C cancels, and so does Ctrl+D on an empty line (not on a non-empty one)', async () => {
  const c = fakeTty();
  const cancelled = promptLine(c.input, c.output, 'Q: ', false);
  c.type('ab\u0003');
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(c.state.raw, false);
  const d = fakeTty();
  const eof = promptLine(d.input, d.output, 'Q: ', true);
  d.type('\u0004');
  await assert.rejects(eof, /cancelled/);
  const kept = fakeTty();
  const answer = promptLine(kept.input, kept.output, 'Q: ', false);
  kept.type('x\u0004y\r');
  assert.equal(await answer, 'xy');
});

test('init suggests serve with the given --config, else the hint the environment sets, else plain serve', () => {
  assert.equal(serveHint(undefined, {}), 'bamboozle serve');
  assert.equal(serveHint(undefined, { BAMBOOZLE_SERVE_HINT: '  ' }), 'bamboozle serve');
  // The container image sets the hint to the compose commands.
  const compose = 'docker compose up -d && docker compose logs -f bamboozle';
  assert.equal(serveHint(undefined, { BAMBOOZLE_SERVE_HINT: compose }), compose);
  assert.equal(serveHint('/tmp/my config.json', { BAMBOOZLE_SERVE_HINT: compose }), "bamboozle serve --config '/tmp/my config.json'");
  assert.equal(serveHint('cfg/a.json', {}), 'bamboozle serve --config cfg/a.json');
});
