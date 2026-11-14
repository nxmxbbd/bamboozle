import type { Config } from './config.ts';
import { PrinterClient, type MqttFactory } from './printer/client.ts';
import { filePinStore } from './printer/pinned-tls.ts';
import type { PrinterStatus } from './printer/status.ts';

export interface ProbeResult {
  name: string;
  ok: boolean;
  status: PrinterStatus | null;
  error?: string;
}

/** How a timed-out probe's error starts when the connection was up and no full report came. */
export const CONNECTED_BUT_SILENT = 'connected, but no full report';

/**
 * Connect to every configured printer, wait for one full status (or the
 * timeout), and disconnect. Nothing but the usual one full-report request is
 * published, and not even that to a listen-only printer. The first connection
 * to a printer pins its certificate.
 */
export function probePrinters(
  config: Config,
  timeoutSeconds: number,
  log: Pick<Console, 'error'> = console,
  createMqtt?: MqttFactory,
): Promise<ProbeResult[]> {
  return Promise.all(
    config.printers.map(
      (printer) =>
        new Promise<ProbeResult>((resolve) => {
          const client = new PrinterClient(printer, filePinStore(config.storagePath, printer.serial), ...(createMqtt ? [createMqtt] : []));
          let lastError: string | undefined;
          let everOnline = false;
          let done = false;
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            void client.stop().then(() =>
              resolve({ name: printer.name, ok, status: client.status, ...(lastError ? { error: lastError } : {}) }),
            );
          };
          const timer = setTimeout(() => {
            // Judged from where the connection stands now: up-but-silent and not-up call for opposite fixes.
            const within = `within ${timeoutSeconds} s`;
            if (client.online) lastError ??= `${CONNECTED_BUT_SILENT} ${within}`;
            else lastError ??= everOnline ? `the connection was lost, and no full report came ${within}` : `no connection ${within}`;
            finish(false);
          }, timeoutSeconds * 1000);
          client.on('online', (online) => {
            if (!online) return;
            everOnline = true;
            lastError = undefined; // what failed before this connection no longer explains anything
          });
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
