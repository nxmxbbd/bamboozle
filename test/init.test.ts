import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('init refuses a kept storagePath that every user can write to, before asking', async () => {
  const opts = options();
  const configDir = join(opts.configPath, '..');
  const shared = join(dir, `shared-${++n}`);
  mkdirSync(configDir, { recursive: true });
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  writeFileSync(opts.configPath, JSON.stringify({ printers: [], storagePath: join(shared, 'state') }));
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 1);
  assert.deepEqual(asked, [], 'nothing was asked');
  assert.ok(said.some((l) => l.includes(shared) && l.includes('writable by every user')), said.join('\n'));
});

test('init stops before asking when the config directory is a dangling symlink', async () => {
  const base = join(dir, `dangling-${++n}`);
  mkdirSync(base);
  symlinkSync(join(base, 'gone'), join(base, 'bamboozle'));
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init(options({ configPath: join(base, 'bamboozle', 'config.json') }), io), 1);
  assert.deepEqual(asked, [], 'nothing was asked');
  assert.ok(said.some((l) => l.startsWith('Cannot write to')), said.join('\n'));
});

test('init refuses a config directory every user can write to, sticky or not', async () => {
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
  assert.equal((await run(0o1777)).code, 1, 'sticky only protects names that exist: others could create storage/ first');
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

test('a typed serial must look like one: init asks again, then gives up without writing', async () => {
  const opts = options();
  const again = fakeIO(['192.0.2.10', '12345678', '../../x', '01p00a000000001', '', ''], { serial: new Error('connection refused') });
  assert.equal(await init(opts, again.io), 0);
  assert.equal(loadConfig(opts.configPath).printers[0]?.serial, '01P00A000000001');
  assert.equal(again.asked.filter((q) => q.startsWith('Printer serial')).length, 2);

  const never = options();
  const bad = fakeIO(['192.0.2.10', '12345678', 'x', 'a/b', 'nope nope'], { serial: new Error('connection refused') });
  await assert.rejects(init(never, bad.io), /no serial/);
  assert.equal(existsSync(never.configPath), false, 'nothing was written');
});

test('init --force leaves a config with several printers alone: it sets up only one', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  const two = JSON.stringify({ printers: [
    { name: 'A', host: '192.0.2.11', serial: '01P00A000000011', accessCode: 'codeaaaa' },
    { name: 'B', host: '192.0.2.12', serial: '01P00A000000012', accessCode: 'codebbbb' },
  ] });
  writeFileSync(opts.configPath, two);
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 1);
  assert.deepEqual(asked, [], 'nothing was asked');
  assert.equal(readFileSync(opts.configPath, 'utf8'), two, 'the file is untouched');
  assert.ok(said.some((l) => l.includes('2 printers')), said.join('\n'));
});

test('init --force leaves a config it cannot parse alone, and says where it breaks', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  const broken = '{\n  "storagePath": "paired-state",\n}\n'; // the classic trailing comma
  writeFileSync(opts.configPath, broken);
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 1);
  assert.deepEqual(asked, [], 'nothing was asked');
  assert.equal(readFileSync(opts.configPath, 'utf8'), broken, 'the file is untouched');
  assert.ok(said.some((l) => /not valid JSON at line \d/.test(l) && l.includes('remove it to start over')), said.join('\n'));
});

test('init --force checks the settings it keeps before asking anything', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  writeFileSync(opts.configPath, JSON.stringify({ printers: [], bridge: { port: '51900' } }));
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 1);
  assert.deepEqual(asked, [], 'nothing was asked');
  assert.ok(said.some((l) => l.includes('bridge.port')), said.join('\n'));
});

test('init --force never shows an old camera URL it would refuse (it may carry the access code)', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  const old = { name: 'P', host: '192.0.2.99', serial: '01P00A000000000', accessCode: 'oldcode1', camera: { source: 'rtsps://bblp:REVIEWSECRET1@192.0.2.99:322/streaming/live/1' } };
  writeFileSync(opts.configPath, JSON.stringify({ printers: [old] }));
  const { io, said, asked } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 0);
  assert.ok(![...said, ...asked].some((l) => l.includes('REVIEWSECRET1')), [...said, ...asked].join('\n'));
  assert.equal(loadConfig(opts.configPath).printers[0]?.cameraSource, undefined);
});

test('init --force keeps only a valid old model and port, says so up front, and matches a padded serial', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  writeFileSync(opts.configPath, JSON.stringify({ printers: [{ name: 'P', host: '192.0.2.99', serial: ' 01p00a000000000 ', accessCode: 'oldcode1', model: 'H2C', port: '8884' }] }));
  const bad = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, bad.io), 0, 'an invalid old port does not fail the run after all questions');
  assert.ok(bad.said.some((l) => l.includes('port') && l.includes('not be kept')), bad.said.join('\n'));
  let printer = loadConfig(opts.configPath).printers[0];
  assert.deepEqual([printer?.model, printer?.port], ['H2C', 8883], 'the padded serial still matched, so the model was kept');

  writeFileSync(opts.configPath, JSON.stringify({ printers: [{ name: 'P', host: '192.0.2.10', serial: ' 01P00A000000000 ', accessCode: 'oldcode1', model: 'H2C', port: 8884 }] }));
  const good = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, good.io), 0);
  printer = loadConfig(opts.configPath).printers[0];
  assert.deepEqual([printer?.model, printer?.port], ['H2C', 8884]);
});

test('init --force keeps the old port only when the address stays the same', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  writeFileSync(opts.configPath, JSON.stringify({ printers: [{ name: 'P', host: ' 192.0.2.10 ', port: 8884, serial: '01P00A000000000', accessCode: 'oldcode1' }] }));
  const { io } = fakeIO(['192.0.2.10', '12345678', '', '']);
  assert.equal(await init({ ...opts, force: true }, io), 0);
  assert.equal(loadConfig(opts.configPath).printers[0]?.port, 8884);
});

test('"none" means no camera however the camera is given', async () => {
  const flag = options();
  assert.equal(await init({ ...flag, camera: 'none' }, fakeIO(['192.0.2.10', '12345678', '']).io), 0);
  assert.equal(loadConfig(flag.configPath).printers[0]?.cameraSource, undefined);
  const typed = options();
  assert.equal(await init(typed, fakeIO(['192.0.2.10', '12345678', '', 'NONE']).io), 0);
  assert.equal(loadConfig(typed.configPath).printers[0]?.cameraSource, undefined);
});

test('init --force offers the old name and camera URL, and keeps model and port for the same printer', async () => {
  const opts = options();
  mkdirSync(join(opts.configPath, '..'), { recursive: true });
  const old = { name: 'Workshop', host: '192.0.2.99', port: 8884, serial: '01P00A000000000', model: 'H2C', accessCode: 'oldcode1', camera: { source: 'rtsp://127.0.0.1:8554/printer' } };
  writeFileSync(opts.configPath, JSON.stringify({ printers: [old] }));
  const keep = fakeIO(['192.0.2.10', '12345678', '', '']); // Enter through name and camera
  assert.equal(await init({ ...opts, force: true }, keep.io), 0);
  const kept = loadConfig(opts.configPath).printers[0];
  assert.deepEqual([kept?.name, kept?.cameraSource, kept?.model, kept?.port, kept?.host], ['Workshop', 'rtsp://127.0.0.1:8554/printer', 'H2C', 8883, '192.0.2.10'],
    'a new address: the old port (a path to the printer, not the printer) is dropped, the model stays');
  assert.ok(keep.asked.some((q) => q.includes('[Workshop]')) && keep.asked.some((q) => q.includes('[rtsp://127.0.0.1:8554/printer]')), keep.asked.join('\n'));

  const none = fakeIO(['192.0.2.10', '12345678', 'Garage', 'none']);
  assert.equal(await init({ ...opts, force: true }, none.io), 0);
  const changed = loadConfig(opts.configPath).printers[0];
  assert.deepEqual([changed?.name, changed?.cameraSource], ['Garage', undefined]);
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

test('a control character ends an escape sequence and still counts: Esc then Ctrl+C cancels, Enter ends a half sequence', async () => {
  const t = fakeTty();
  const cancelled = promptLine(t.input, t.output, 'Q: ', true);
  t.type('\u001b\u0003');
  await assert.rejects(cancelled, /cancelled/);
  const half = fakeTty();
  const answer = promptLine(half.input, half.output, 'Q: ', false);
  half.type('ab\u001b[1\r');
  assert.equal(await answer, 'ab');
});

test('a lone Esc (its own keypress) does not eat the next character', async () => {
  const t = fakeTty();
  const answer = promptLine(t.input, t.output, 'Code: ', true);
  t.type('12');
  t.type('\u001b');
  await new Promise((r) => setTimeout(r, 150)); // a person, not a terminal sequence
  t.type('34\r');
  assert.equal(await answer, '1234');
});

test('an arrow key split across reads at any point never lands in the answer', async () => {
  for (const input of ['1234\u001b[D5678\r', '1234\u001bOA5678\r']) {
    for (let cut = 1; cut < input.length; cut++) {
      const t = fakeTty();
      const answer = promptLine(t.input, t.output, 'Code: ', true);
      t.type(input.slice(0, cut));
      t.type(input.slice(cut));
      assert.equal(await answer, '12345678', `${JSON.stringify(input)} cut at ${cut}`);
    }
  }
});

test('when echoing or setting up the terminal throws, the prompt fails and the terminal is restored', async () => {
  const t = fakeTty();
  let fail = false;
  const output = { write: (text: string) => { if (fail) throw new Error('EPIPE'); return text; } };
  const echoing = promptLine(t.input, output, 'Name: ', false);
  fail = true;
  t.type('x');
  await assert.rejects(echoing, /EPIPE/);
  assert.equal(t.state.raw, false, 'raw mode is off again');
  t.type('more\r'); // the listener is gone: nothing happens

  const s = fakeTty();
  const resume = s.input.resume;
  s.input.resume = () => { throw new Error('EIO'); };
  await assert.rejects(promptLine(s.input, s.output, 'Q: ', true), /EIO/);
  assert.equal(s.state.raw, false, 'raw mode is off again');
  s.input.resume = resume;
});
