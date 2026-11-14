// A printer's MQTT side, for tests about what bamboozle sends: a TLS server
// that speaks just enough MQTT to take a connection and a subscription, send
// one full report per connection, and record every packet it is sent.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'node:tls';

export const CONNECT = 1;
export const PUBLISH = 3;
export const SUBSCRIBE = 8;
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

interface Login {
  username: string | null;
  password: string | null;
}

/** User name and password of a CONNECT packet (MQTT 3.1.1); null for one the packet does not carry. */
function login(body: Buffer): Login {
  const flags = body[7] ?? 0;
  let at = 10; // protocol name, level, flags and keep-alive come first
  const text = () => {
    const length = body.readUInt16BE(at);
    at += 2 + length;
    return body.subarray(at - length, at).toString();
  };
  text(); // the client id
  if (flags & 0x04) {
    text(); // a will: its topic
    text(); // and its message
  }
  return { username: flags & 0x80 ? text() : null, password: flags & 0x40 ? text() : null };
}

/** The topic filters of a SUBSCRIBE packet. */
function topicFilters(body: Buffer): string[] {
  const filters: string[] = [];
  // After the packet id: each filter is followed by the QoS asked for.
  for (let at = 2; at + 2 <= body.length; ) {
    const length = body.readUInt16BE(at);
    filters.push(body.subarray(at + 2, at + 2 + length).toString());
    at += 2 + length + 1;
  }
  return filters;
}

export interface Seen {
  /** Type of every packet the client sent, in order. */
  types: number[];
  /** What the client logged in with, once per connection. */
  logins: Login[];
  /** Every topic filter the client subscribed to, in order. */
  subscriptions: string[];
  publishes: Array<{ topic: string; payload: string }>;
  /** Bytes the client sent that never made a whole packet: must stay 0, or a packet went unread. */
  unparsed: number;
}

export type Behaviour = 'reports unasked' | 'answers when asked';

export interface TlsIdentity {
  key: string;
  cert: string;
}

/** A self-signed certificate for a fake printer, written to `dir`; null without openssl. */
export function tlsIdentity(dir: string, commonName: string): TlsIdentity | null {
  try {
    const key = join(dir, `${commonName}.key`);
    const cert = join(dir, `${commonName}.crt`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${commonName}`], { stdio: 'ignore' });
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  } catch {
    return null;
  }
}

// A printer reports about once a second. The unasked report waits this long
// after the subscription, so a request the client was going to send is on the
// wire before the report lets a probe hang up (sent at once, the report won
// that race and a client that did ask looked silent).
const UNASKED_REPORT_AFTER_MS = 300;
// A client that never connects, or never hangs up, fails the test instead of hanging it.
const HUNG_UP_WITHIN_MS = 10_000;

export interface FakePrinterOptions {
  identity: TlsIdentity;
  /** Names the topics: reports go out on device/<serial>/report, to a client that subscribed to exactly that. */
  serial: string;
  /** The full report it sends, once per connection. */
  report: Buffer;
  behaviour: Behaviour;
}

export interface FakePrinter {
  port: number;
  seen: Seen;
  /** Resolves once the client has connected and every connection has closed: all it sent has been read by then. */
  hungUp(): Promise<void>;
  /** Closes every connection it holds; it takes new ones right away. */
  drop(): void;
  /** Stops the server and everything it still holds. */
  close(): void;
}

/** A printer's MQTT side: accepts the connection and the subscription, and sends one full report. */
export function fakePrinter({ identity, serial, report: fullReport, behaviour }: FakePrinterOptions): Promise<FakePrinter> {
  const seen: Seen = { types: [], logins: [], subscriptions: [], publishes: [], unparsed: 0 };
  const reportTopic = `device/${serial}/report`;
  // Raw connections count from the TCP accept, so a client that gives up during the TLS handshake still hangs up.
  const open = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let connections = 0;
  const waiting: Array<() => void> = [];
  const closed = (socket: Socket) => {
    open.delete(socket);
    if (open.size === 0) for (const done of waiting.splice(0)) done();
  };
  const server = createServer(identity, (socket) => {
    open.add(socket);
    let buffer = Buffer.alloc(0);
    // As with a broker: a client that did not subscribe to the report topic gets no report.
    let subscribed = false;
    const report = () => {
      if (subscribed && !socket.destroyed) socket.write(publishPacket(reportTopic, fullReport));
    };
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (let packet = takePacket(buffer); packet; packet = takePacket(buffer)) {
        buffer = buffer.subarray(packet.length);
        seen.types.push(packet.type);
        if (packet.type === CONNECT) {
          seen.logins.push(login(packet.body));
          socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        }
        if (packet.type === SUBSCRIBE) {
          const filters = topicFilters(packet.body);
          seen.subscriptions.push(...filters);
          socket.write(Buffer.from([0x90, 0x03, packet.body[0] as number, packet.body[1] as number, 0x00]));
          if (filters.includes(reportTopic)) {
            subscribed = true;
            if (behaviour === 'reports unasked') timers.add(setTimeout(report, UNASKED_REPORT_AFTER_MS));
          }
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
  const drop = () => {
    for (const socket of open) socket.destroy();
  };
  const close = () => {
    for (const timer of timers) clearTimeout(timer);
    drop();
    server.close();
  };
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
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, seen, hungUp, drop, close }));
  });
}

/** What the client sent besides keep-alive pings and a goodbye. */
export const sent = (seen: Seen): number[] => seen.types.filter((type) => type !== PINGREQ && type !== DISCONNECT);
