import type { Config } from './config.ts';
import { PrinterClient } from './printer/client.ts';
import { filePinStore } from './printer/pinned-tls.ts';
import type { PrinterStatus } from './printer/status.ts';

export interface ProbeResult {
  name: string;
  ok: boolean;
  status: PrinterStatus | null;
  error?: string;
}

/**
 * Connect to every configured printer, wait for one full status (or the
 * timeout), and disconnect. Nothing but the usual one full-report request is
 * sent. The first connection to a printer pins its certificate.
 */
export function probePrinters(
  config: Config,
  timeoutSeconds: number,
  log: Pick<Console, 'error'> = console,
): Promise<ProbeResult[]> {
  return Promise.all(
    config.printers.map(
      (printer) =>
        new Promise<ProbeResult>((resolve) => {
          const client = new PrinterClient(printer, filePinStore(config.storagePath, printer.serial));
          let lastError: string | undefined;
          let done = false;
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            void client.stop().then(() =>
              resolve({ name: printer.name, ok, status: client.status, ...(lastError ? { error: lastError } : {}) }),
            );
          };
          const timer = setTimeout(() => finish(false), timeoutSeconds * 1000);
          client.on('pinned', (fingerprint) => log.error(`[${printer.name}] pinned certificate ${fingerprint}`));
          client.on('error', (error) => {
            lastError = error.message;
            log.error(`[${printer.name}] ${error.message}`);
          });
          client.on('status', () => {
            if (client.hasFullStatus) finish(true);
          });
          client.start();
        }),
    ),
  );
}
