#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { PrinterClient } from './printer/client.ts';
import { filePinStore } from './printer/pinned-tls.ts';
import { serve } from './serve.ts';

const USAGE = `usage:
  bamboozle serve --config <file> [--simulate]
  bamboozle probe --config <file> [--timeout <seconds>]

  serve   run the HomeKit bridge for every configured printer
          --simulate  feed a simulated print cycle instead of the printers,
                      to see how each display style looks in the Home app
  probe   connect to every configured printer, request one full status,
          print it as JSON and exit (no HomeKit, nothing else sent)`;

async function probe(configPath: string, timeoutSeconds: number): Promise<number> {
  const config = loadConfig(configPath);
  const results = await Promise.all(
    config.printers.map(
      (printer) =>
        new Promise<{ name: string; ok: boolean; status: unknown; error?: string }>((resolve) => {
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
          client.on('pinned', (fingerprint) => console.error(`[${printer.name}] pinned certificate ${fingerprint}`));
          client.on('error', (error) => {
            lastError = error.message;
            console.error(`[${printer.name}] ${error.message}`);
          });
          client.on('status', () => {
            if (client.hasFullStatus) finish(true);
          });
          client.start();
        }),
    ),
  );
  console.log(JSON.stringify(results, null, 2));
  return results.every((result) => result.ok) ? 0 : 1;
}

async function runServe(configPath: string, simulate: boolean): Promise<number> {
  const stop = await serve(loadConfig(configPath), { simulate });
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  console.log('stopping');
  await stop();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      timeout: { type: 'string', default: '20' },
      simulate: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (command !== 'probe' && command !== 'serve') {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (!values.config) {
    console.error(`--config is required\n\n${USAGE}`);
    return 2;
  }
  if (command === 'serve') return runServe(values.config, values.simulate);

  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    console.error('--timeout must be a positive number of seconds');
    return 2;
  }
  return probe(values.config, timeout);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
