import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TlsIdentity {
  key: string;
  cert: string;
}

/** A self-signed certificate (EC P-256, one day) for a TLS server in a test, written to `dir`; null without openssl. */
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
