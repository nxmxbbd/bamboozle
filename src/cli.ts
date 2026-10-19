#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { init, serveHint, terminalIO } from './init.ts';
import { openToEveryone, resolveConfigPath } from './paths.ts';
import { readPrinterSerial } from './printer/serial.ts';
import { probePrinters } from './probe.ts';
import { serve } from './serve.ts';

const USAGE = `usage:
  bamboozle init  [--config <file>] [--host <ip>] [--name <name>] [--camera <url>] [--force]
  bamboozle serve [--config <file>] [--simulate]
  bamboozle probe [--config <file>] [--timeout <seconds>]

  init    set up one printer: asks for its address and LAN access code,
          reads its serial, writes the config and checks the connection
  serve   run the HomeKit bridge for every configured printer; while it is
          not paired it shows a code to scan with the iPhone camera
          --simulate  feed a simulated print cycle instead of the printers,
                      to see how each display style looks in the Home app
  probe   connect to every configured printer, request one full status,
          print it as JSON and exit (no HomeKit, nothing else sent)

The config is --config, else $BAMBOOZLE_CONFIG, else
$XDG_CONFIG_HOME/bamboozle/config.json (~/.config/bamboozle/config.json).`;

function requireConfig(path: string): boolean {
  if (existsSync(path)) return true;
  console.error(`no config at ${path}. Run "bamboozle init" first, or pass --config <file>.`);
  return false;
}

async function runProbe(configPath: string, timeoutSeconds: number): Promise<number> {
  const results = await probePrinters(loadConfig(configPath), timeoutSeconds);
  console.log(JSON.stringify(results, null, 2));
  return results.every((result) => result.ok) ? 0 : 1;
}

async function runServe(configPath: string, simulate: boolean): Promise<number> {
  console.log(`config ${configPath}`);
  const config = loadConfig(configPath);
  // Not a refusal (it may have run like this for years), but loud.
  const open = new Set([dirname(resolve(configPath)), config.storagePath].map(openToEveryone).filter((dir) => dir !== null));
  for (const dir of open) {
    console.warn(`warning: ${dir} is writable by every user on this machine, so anyone could swap the config or the pairing keys (chmod o-w it)`);
  }
  const stop = await serve(config, { simulate, tty: process.stdout.isTTY === true });
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  console.log('stopping');
  await stop();
  return 0;
}

async function runInit(configPath: string, values: { config?: string; host?: string; name?: string; camera?: string; force: boolean }): Promise<number> {
  const io = terminalIO(
    (host) => readPrinterSerial(host),
    async (path) => {
      const [result] = await probePrinters(loadConfig(path), 20, { error: () => {} });
      if (!result?.ok || !result.status) return { ok: false, error: result?.error ?? 'no full status within 20 s' };
      const { state, progress } = result.status;
      return { ok: true, summary: state === 'printing' ? `${state}, ${progress} %` : state };
    },
  );
  try {
    return await init(
      {
        configPath,
        ...(values.host !== undefined ? { host: values.host } : {}),
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.camera !== undefined ? { camera: values.camera } : {}),
        force: values.force,
        serveCommand: serveHint(values.config),
      },
      io,
    );
  } finally {
    io.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      timeout: { type: 'string', default: '20' },
      simulate: { type: 'boolean', default: false },
      host: { type: 'string' },
      name: { type: 'string' },
      camera: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (command !== 'init' && command !== 'probe' && command !== 'serve') {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  const configPath = resolveConfigPath(values.config);
  if (command === 'init') return runInit(configPath, values);
  if (!requireConfig(configPath)) return 2;
  if (command === 'serve') return runServe(configPath, values.simulate);

  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    console.error('--timeout must be a positive number of seconds');
    return 2;
  }
  return runProbe(configPath, timeout);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
