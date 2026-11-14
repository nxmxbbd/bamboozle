// Nothing is published to a printer marked listenOnly. Checked on the client
// with a stand-in MQTT client, and on the wire: the real probe, MQTT client
// and pinned TLS connection against a server that speaks just enough MQTT to
// record every packet it is sent.

import { test, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:tls';
import { ConfigError, parseConfig } from '../src/config.ts';
import { PrinterClient, type MqttFactory, type PrinterConnection } from '../src/printer/client.ts';
import { probePrinters } from '../src/probe.ts';

const FULL_REPORT = readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url));
const CONNECTION: PrinterConnection = { name: 'Printer', host: '192.0.2.10', port: 8883, serial: 'S1', accessCode: 'a' };

// A stand-in for the MQTT client, driven by hand.
class FakeMqtt extends EventEmitter {
  subscribed: string[] = [];
  published: Array<{ topic: string; payload: string }> = [];
  subscribe(topic: string, _options: unknown, callback: (error: Error | null) => void) {
    this.subscribed.push(topic);
    callback(null);
    return this;
  }
  publish(topic: string, payload: string) {
    this.published.push({ topic, payload });
    return this;
  }
  connect() {
    return this;
  }
  async endAsync() {}
}

function clientWith(connection: PrinterConnection): { client: PrinterClient; fake: FakeMqtt } {
  const fake = new FakeMqtt();
  const client = new PrinterClient(connection, { load: () => null, save: () => {} }, (() => fake) as unknown as MqttFactory);
  client.start();
  return { client, fake };
}

test('nothing is published to a listen-only printer, on the first connection or after a reconnect', () => {
  const { client, fake } = clientWith({ ...CONNECTION, listenOnly: true });
  fake.emit('connect');
  fake.emit('close');
  fake.emit('connect');
  assert.deepEqual(fake.subscribed, ['device/S1/report', 'device/S1/report'], 'it still listens in both sessions');
  assert.deepEqual(fake.published, []);
  assert.equal(client.online, true);
});

test('a listen-only printer that reports its whole status unasked is available', () => {
  const { client, fake } = clientWith({ ...CONNECTION, listenOnly: true });
  fake.emit('connect');
  assert.equal(client.hasFullStatus, false, 'nothing yet');
  fake.emit('message', 'device/S1/report', FULL_REPORT);
  assert.equal(client.hasFullStatus, true);
  assert.equal(client.status?.progress, 47);
  assert.deepEqual(fake.published, []);
});

test('every other printer is asked for its status once per connection', () => {
  for (const connection of [CONNECTION, { ...CONNECTION, listenOnly: false }]) {
    const { fake } = clientWith(connection);
    fake.emit('connect');
    fake.emit('close');
    fake.emit('connect');
    assert.equal(fake.published.length, 2, 'one request per session');
    for (const { topic, payload } of fake.published) {
      assert.equal(topic, 'device/S1/request');
      assert.equal((JSON.parse(payload) as { pushing: { command: string } }).pushing.command, 'pushall');
    }
  }
});

test('listenOnly is true or false in the config; a printer without it is asked as before', () => {
  const base = { name: 'Printer', host: '192.0.2.10', serial: 'S1', accessCode: 'a' };
  const parse = (extra: Record<string, unknown>) => parseConfig({ printers: [{ ...base, ...extra }] }, '/srv').printers[0];
  assert.equal(parse({ listenOnly: true })?.listenOnly, true);
  assert.equal(parse({ listenOnly: false })?.listenOnly, false);
  assert.equal(parse({})?.listenOnly ?? false, false);
  // Anything else is refused rather than guessed: "false" as a string must not switch the request off or on by accident.
  for (const bad of ['true', 'false', 1, 0, null, [], {}]) {
    assert.throws(
      () => parse({ listenOnly: bad }),
      (error: unknown) => error instanceof ConfigError && /printers\[0\]\.listenOnly must be true or false/.test(error.message),
      JSON.stringify(bad),
    );
  }
});

// --- on the wire -------------------------------------------------------------

const CONNECT = 1;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const PINGREQ = 12;
const DISCONNECT = 14;

interface Packet {
  type: number;
  body: Buffer;
  length: number;
}

/** The first whole MQTT packet in the buffer, or null while it is incomplete. */
function takePacket(buffer: Buffer): Packet | null {
  let remaining = 0;
  let index = 1;
  for (let shift = 0; ; shift += 7) {
    const byte = buffer[index++];
    if (byte === undefined) return null;
    remaining |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
  }
  if (buffer.length < index + remaining) return null;
  return { type: (buffer[0] as number) >> 4, body: buffer.subarray(index, index + remaining), length: index + remaining };
}

/** A QoS 0 PUBLISH packet. */
function publishPacket(topic: string, payload: Buffer): Buffer {
  const name = Buffer.from(topic);
  const length: number[] = [];
  let remaining = 2 + name.length + payload.length;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    length.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  const nameLength = Buffer.alloc(2);
  nameLength.writeUInt16BE(name.length);
  return Buffer.concat([Buffer.from([0x30, ...length]), nameLength, name, payload]);
}

interface Seen {
  /** Type of every packet the client sent, in order. */
  types: number[];
  publishes: Array<{ topic: string; payload: string }>;
  /** Bytes the client sent that never made a whole packet: must stay 0, or a packet went unread. */
  unparsed: number;
}

type Behaviour = 'reports unasked' | 'answers when asked';

let dir = '';
let identity: { key: string; cert: string } | null = null;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'bamboozle-listen-'));
  try {
    const key = join(dir, 'printer.key');
    const cert = join(dir, 'printer.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=S1'], { stdio: 'ignore' });
    identity = { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  } catch {
    identity = null; // no openssl: the wire tests are skipped
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

// A printer reports about once a second. The unasked report waits this long
// after the subscription, so a request the client was going to send is on the
// wire before the report lets the probe hang up (sent at once, the report won
// that race and a client that did ask looked silent).
const UNASKED_REPORT_AFTER_MS = 300;
// A client that never connects, or never hangs up, fails the test instead of hanging it.
const HUNG_UP_WITHIN_MS = 10_000;
const WIRE_TEST = { timeout: 30_000 };

interface FakePrinter {
  port: number;
  seen: Seen;
  /** Resolves once the client has connected and every connection has closed: all it sent has been read by then. */
  hungUp(): Promise<void>;
}

/** A printer's MQTT side: accepts the connection and the subscription, and sends one full report. */
function fakePrinter(t: TestContext, behaviour: Behaviour): Promise<FakePrinter> {
  const seen: Seen = { types: [], publishes: [], unparsed: 0 };
  // Raw connections count from the TCP accept, so a client that gives up during the TLS handshake still hangs up.
  const open = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let connections = 0;
  const waiting: Array<() => void> = [];
  const closed = (socket: Socket) => {
    open.delete(socket);
    if (open.size === 0) for (const done of waiting.splice(0)) done();
  };
  const server = createServer(identity as { key: string; cert: string }, (socket) => {
    open.add(socket);
    let buffer = Buffer.alloc(0);
    const report = () => {
      if (!socket.destroyed) socket.write(publishPacket('device/S1/report', FULL_REPORT));
    };
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (let packet = takePacket(buffer); packet; packet = takePacket(buffer)) {
        buffer = buffer.subarray(packet.length);
        seen.types.push(packet.type);
        if (packet.type === CONNECT) socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        if (packet.type === SUBSCRIBE) {
          socket.write(Buffer.from([0x90, 0x03, packet.body[0] as number, packet.body[1] as number, 0x00]));
          if (behaviour === 'reports unasked') timers.add(setTimeout(report, UNASKED_REPORT_AFTER_MS));
        }
        if (packet.type === PUBLISH) {
          const topicLength = packet.body.readUInt16BE(0);
          seen.publishes.push({ topic: packet.body.subarray(2, 2 + topicLength).toString(), payload: packet.body.subarray(2 + topicLength).toString() });
          if (behaviour === 'answers when asked') report();
        }
        if (packet.type === PINGREQ) socket.write(Buffer.from([0xd0, 0x00]));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      seen.unparsed += buffer.length;
      closed(socket);
    });
  });
  server.on('connection', (raw: Socket) => {
    connections += 1;
    open.add(raw);
    raw.on('close', () => closed(raw));
  });
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of open) socket.destroy();
    server.close();
  });
  const hungUp = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the client did not connect and hang up within ${HUNG_UP_WITHIN_MS / 1000} s`)), HUNG_UP_WITHIN_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (connections > 0 && open.size === 0) done();
      else waiting.push(done);
    });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, seen, hungUp }));
  });
}

let run = 0;
function probe(port: number, extra: Record<string, unknown>, timeoutSeconds: number) {
  const config = parseConfig(
    { printers: [{ name: 'Printer', host: '127.0.0.1', port, serial: 'S1', accessCode: '12345678', ...extra }], storagePath: `storage-${++run}` },
    dir,
  );
  return probePrinters(config, timeoutSeconds, { error: () => {} });
}

/** What the client sent besides keep-alive pings and a goodbye. */
const sent = (seen: Seen) => seen.types.filter((type) => type !== PINGREQ && type !== DISCONNECT);

test('on the wire, a listen-only printer gets a connection and a subscription and no publish', WIRE_TEST, async (t) => {
  if (!identity) return t.skip('openssl not available');
  const printer = await fakePrinter(t, 'reports unasked');
  const [result] = await probe(printer.port, { listenOnly: true }, 10);
  await printer.hungUp();
  assert.equal(result?.ok, true, 'its own report is enough');
  assert.equal(result?.status?.progress, 47);
  assert.deepEqual(printer.seen.publishes, []);
  assert.deepEqual(sent(printer.seen), [CONNECT, SUBSCRIBE]);
  assert.equal(printer.seen.unparsed, 0);
});

test('on the wire, any other printer gets exactly one status request', WIRE_TEST, async (t) => {
  if (!identity) return t.skip('openssl not available');
  const printer = await fakePrinter(t, 'answers when asked');
  const [result] = await probe(printer.port, {}, 10);
  await printer.hungUp();
  assert.equal(result?.ok, true, 'the request was sent and answered');
  assert.equal(printer.seen.publishes.length, 1);
  assert.equal(printer.seen.publishes[0]?.topic, 'device/S1/request');
  assert.equal((JSON.parse(printer.seen.publishes[0]?.payload ?? '{}') as { pushing?: { command?: string } }).pushing?.command, 'pushall');
  assert.equal(printer.seen.unparsed, 0);
});

test('on the wire, a listen-only printer that waits to be asked is left alone: no status, and still no publish', WIRE_TEST, async (t) => {
  if (!identity) return t.skip('openssl not available');
  const printer = await fakePrinter(t, 'answers when asked');
  // Three seconds: room to connect and subscribe on a slow machine, then silence until the probe gives up.
  const [result] = await probe(printer.port, { listenOnly: true }, 3);
  await printer.hungUp();
  assert.equal(result?.ok, false);
  assert.equal(result?.error, 'connected, but no full report within 3 s');
  assert.deepEqual(printer.seen.publishes, []);
  assert.deepEqual(sent(printer.seen), [CONNECT, SUBSCRIBE]);
  assert.equal(printer.seen.unparsed, 0);
});

test('a probe that never gets through says so, rather than look like a printer that waits to be asked', WIRE_TEST, async (t) => {
  // Takes the TCP connection and then says nothing, so the TLS handshake never finishes.
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  const [result] = await probe(port, { listenOnly: true }, 1);
  assert.equal(result?.ok, false);
  assert.equal(result?.error, 'no connection within 1 s');
});

// --- what a probe that ran out of time says ----------------------------------

/** A probe of one listen-only printer through the stand-in MQTT client; `drive` plays the connection's part. */
async function timedOut(drive: (fake: FakeMqtt) => void) {
  const fake = new FakeMqtt();
  const config = parseConfig({ printers: [{ name: 'Printer', host: '192.0.2.10', serial: 'S1', accessCode: 'a', listenOnly: true }], storagePath: 'unused' }, dir);
  const pending = probePrinters(config, 0.05, { error: () => {} }, (() => fake) as unknown as MqttFactory);
  drive(fake);
  const [result] = await pending;
  assert.equal(result?.ok, false);
  assert.deepEqual(fake.published, []);
  return result?.error;
}

test('a probe that ran out of time says where the connection stood then, not what happened along the way', async () => {
  const refused = new Error('connect ECONNREFUSED');
  // Up and silent: for a listen-only printer this is the one result that points at listenOnly.
  assert.equal(await timedOut((fake) => fake.emit('connect')), 'connected, but no full report within 0.05 s');
  assert.equal(
    await timedOut((fake) => {
      fake.emit('error', refused); // the first try failed, the next one got through
      fake.emit('connect');
    }),
    'connected, but no full report within 0.05 s',
  );
  // Not up: never made, lost, or failing. None of these may read as "connected, but no full report".
  assert.equal(await timedOut(() => {}), 'no connection within 0.05 s');
  assert.equal(
    await timedOut((fake) => {
      fake.emit('connect');
      fake.emit('close');
    }),
    'the connection was lost, and no full report came within 0.05 s',
  );
  assert.equal(
    await timedOut((fake) => {
      fake.emit('connect');
      fake.emit('close');
      fake.emit('error', refused);
    }),
    'connect ECONNREFUSED',
  );
  assert.equal(await timedOut((fake) => fake.emit('error', new Error('Connection refused: Not authorized'))), 'Connection refused: Not authorized');
  // Up, but something failed on this connection: that error is the news.
  assert.equal(
    await timedOut((fake) => {
      fake.emit('connect');
      fake.emit('error', new Error('subscription refused'));
    }),
    'subscription refused',
  );
});
