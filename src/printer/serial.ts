import { connect } from 'node:tls';

/** Bambu printer serials are upper-case letters and digits. */
const SERIAL = /^[0-9A-Z]{8,20}$/;

export const isPrinterSerial = (text: string): boolean => SERIAL.test(text);

/**
 * Read a printer's serial number from its TLS certificate: Bambu printers
 * present a self-signed leaf whose common name is the serial. Only the
 * handshake happens; nothing is sent. The certificate is not trusted here
 * (it cannot be: it is self-signed); the first real connection pins it.
 */
export function readPrinterSerial(host: string, port = 8883, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false });
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`no TLS answer from ${host}:${port} within ${timeoutMs / 1000} s`)), timeoutMs);
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const cn = socket.getPeerCertificate().subject?.CN;
      const name = Array.isArray(cn) ? cn[0] : cn;
      clearTimeout(timer);
      socket.destroy();
      if (typeof name === 'string' && SERIAL.test(name)) resolve(name);
      else reject(new Error(`the certificate at ${host}:${port} does not name a printer serial`));
    });
  });
}
