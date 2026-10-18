import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Server } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  CertificatePinError,
  connectPinned,
  filePinStore,
  type PinStore,
  type TlsConnect,
} from '../src/printer/pinned-tls.ts';

// Throwaway self-signed certificates, generated per run so no key is committed.
let dir = '';
let certA = { key: '', cert: '', fingerprint: '' };
let certB = { key: '', cert: '', fingerprint: '' };

function makeCert(name: string) {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${name}`], { stdio: 'ignore' });
  const pem = readFileSync(cert, 'utf8');
  return { key: readFileSync(key, 'utf8'), cert: pem, fingerprint: new X509Certificate(pem).fingerprint256 };
}

let hasOpenssl = true;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'bamboozle-tls-'));
  try {
    certA = makeCert('printer-a');
    certB = makeCert('printer-b');
  } catch {
    hasOpenssl = false;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

interface Echo {
  server: Server;
  port: number;
  received: () => number;
}

function echoServer(identity: { key: string; cert: string }): Promise<Echo> {
  let bytes = 0;
  const server = createServer(identity, (socket) => {
    socket.on('data', (data) => {
      bytes += data.length;
      socket.write(Buffer.concat([Buffer.from('echo:'), data]));
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, received: () => bytes }),
    );
  });
}

function memoryPins(initial: string | null): PinStore & { saved: string[] } {
  let value = initial;
  const saved: string[] = [];
  return {
    saved,
    load: () => value,
    save: (fingerprint) => {
      value = fingerprint;
      saved.push(fingerprint);
    },
  };
}

function firstData(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    stream.once('data', (data: Buffer) => resolve(data.toString()));
    stream.once('error', reject);
  });
}

test('first contact pins the certificate, then traffic flows both ways', async (t) => {
  if (!hasOpenssl) return t.skip('openssl not available');
  const echo = await echoServer(certA);
  t.after(() => echo.server.close());
  const pins = memoryPins(null);
  let announced = '';
  const stream = connectPinned('127.0.0.1', echo.port, pins, (fp) => (announced = fp));
  stream.write('hello'); // written before the handshake: must be held, then delivered
  assert.equal(await firstData(stream), 'echo:hello');
  assert.deepEqual(pins.saved, [certA.fingerprint]);
  assert.equal(announced, certA.fingerprint);
  stream.destroy();
});

test('a matching pin connects without re-saving', async (t) => {
  if (!hasOpenssl) return t.skip('openssl not available');
  const echo = await echoServer(certA);
  t.after(() => echo.server.close());
  const pins = memoryPins(certA.fingerprint);
  const stream = connectPinned('127.0.0.1', echo.port, pins);
  stream.write('ping');
  assert.equal(await firstData(stream), 'echo:ping');
  assert.deepEqual(pins.saved, []);
  stream.destroy();
});

test('a different certificate is rejected and receives nothing', async (t) => {
  if (!hasOpenssl) return t.skip('openssl not available');
  const impostor = await echoServer(certB);
  t.after(() => impostor.server.close());
  const pins = memoryPins(certA.fingerprint);
  const stream = connectPinned('127.0.0.1', impostor.port, pins);
  stream.write('MQTT CONNECT with the access code');
  const error = await new Promise<Error>((resolve) => stream.once('error', resolve));
  assert.ok(error instanceof CertificatePinError, `expected CertificatePinError, got ${error.name}`);
  assert.match(error.message, /does not match the pinned/);
  // Give the socket a moment to flush anything it might have sent.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(impostor.received(), 0, 'no byte may reach a server with the wrong certificate');
  assert.deepEqual(pins.saved, []);
});

test('nothing is handed to TLS before the pin check passes', async (t) => {
  // Node happens to defer pre-handshake writes past `secureConnect` today;
  // this pins down the gate's own contract so the guarantee does not depend
  // on that ordering.
  if (!hasOpenssl) return t.skip('openssl not available');
  const impostor = await echoServer(certB);
  t.after(() => impostor.server.close());
  const handedToTls: string[] = [];
  const spyConnect: TlsConnect = (options) => {
    const socket = connect(options);
    const write = socket.write.bind(socket) as (...args: unknown[]) => boolean;
    socket.write = ((chunk: unknown, ...rest: unknown[]) => {
      handedToTls.push(String(chunk));
      return write(chunk, ...rest);
    }) as typeof socket.write;
    return socket;
  };
  const stream = connectPinned('127.0.0.1', impostor.port, memoryPins(certA.fingerprint), undefined, spyConnect);
  stream.write('MQTT CONNECT with the access code');
  await new Promise((resolve) => stream.once('error', resolve));
  assert.deepEqual(handedToTls, []);
});

test('connection failures surface as errors', async (t) => {
  if (!hasOpenssl) return t.skip('openssl not available');
  const echo = await echoServer(certA);
  const { port } = echo;
  await new Promise((resolve) => echo.server.close(resolve));
  const stream = connectPinned('127.0.0.1', port, memoryPins(null));
  const error = await new Promise<NodeJS.ErrnoException>((resolve) => stream.once('error', resolve));
  assert.equal(error.code, 'ECONNREFUSED');
});

test('filePinStore persists one pin per serial with private permissions', () => {
  const storage = mkdtempSync(join(tmpdir(), 'bamboozle-pins-'));
  try {
    const store = filePinStore(storage, 'SERIAL1');
    assert.equal(store.load(), null);
    store.save('AA:BB');
    assert.equal(store.load(), 'AA:BB');
    assert.equal(filePinStore(storage, 'SERIAL2').load(), null);
    const mode = statSync(join(storage, 'pins', 'SERIAL1.sha256')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});
