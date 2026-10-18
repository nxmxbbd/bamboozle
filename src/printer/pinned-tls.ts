import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls';

export type TlsConnect = (options: ConnectionOptions) => TLSSocket;

export interface PinStore {
  load(): string | null;
  save(fingerprint: string): void;
}

export class CertificatePinError extends Error {
  override name = 'CertificatePinError';
}

/** One SHA-256 fingerprint per printer serial, under `<storage>/pins/`. */
export function filePinStore(storagePath: string, serial: string): PinStore {
  const dir = join(storagePath, 'pins');
  const file = join(dir, `${serial}.sha256`);
  return {
    load() {
      try {
        const value = readFileSync(file, 'utf8').trim();
        return value === '' ? null : value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    save(fingerprint) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${fingerprint}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    },
  };
}

interface PendingWrite {
  chunk: Buffer;
  callback: (error?: Error | null) => void;
}

/**
 * TLS connection to a printer, pinned to the certificate seen first (trust
 * on first use).
 *
 * Bambu printers present a leaf certificate whose issuer is in no public
 * bundle, so chain verification cannot work and the pin replaces it. The
 * returned stream holds every write until the pin has been checked: the
 * MQTT CONNECT packet carries the access code, and an MQTT client writes it
 * the moment the stream exists, before any TLS handshake has finished.
 * (Node itself also defers pre-handshake writes until after `secureConnect`,
 * but the guarantee should not rest on that internal ordering.)
 */
export function connectPinned(
  host: string,
  port: number,
  pins: PinStore,
  onPinned?: (fingerprint: string) => void,
  tlsConnect: TlsConnect = connect,
): Duplex {
  const socket = tlsConnect({ host, port, rejectUnauthorized: false });
  const pending: PendingWrite[] = [];
  let verified = false;

  const gate = new Duplex({
    write(chunk: Buffer, _encoding, callback) {
      if (verified) socket.write(chunk, callback);
      else pending.push({ chunk, callback });
    },
    read() {
      socket.resume();
    },
    final(callback) {
      socket.end(() => callback());
    },
    destroy(error, callback) {
      for (const write of pending.splice(0)) write.callback(error ?? new Error('connection closed'));
      socket.destroy();
      callback(error);
    },
  });

  socket.on('secureConnect', () => {
    try {
      checkPin();
    } catch (error) {
      // An unreadable pin or a full disk fails this connection, not the process.
      gate.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const checkPin = () => {
    const fingerprint = socket.getPeerCertificate().fingerprint256;
    const expected = pins.load();
    if (!fingerprint) {
      gate.destroy(new CertificatePinError(`${host}: printer presented no certificate`));
      return;
    }
    if (expected !== null && fingerprint !== expected) {
      gate.destroy(
        new CertificatePinError(
          `${host}: certificate ${fingerprint} does not match the pinned ${expected}. ` +
            'If the printer was replaced or reset, delete its pin file to trust the new certificate.',
        ),
      );
      return;
    }
    if (expected === null) {
      pins.save(fingerprint);
      onPinned?.(fingerprint);
    }
    verified = true;
    for (const { chunk, callback } of pending.splice(0)) socket.write(chunk, callback);
  };
  socket.on('data', (data: Buffer) => {
    if (!gate.push(data)) socket.pause();
  });
  socket.on('end', () => gate.push(null));
  socket.on('error', (error) => gate.destroy(error));
  socket.on('close', () => gate.destroy());

  return gate;
}
