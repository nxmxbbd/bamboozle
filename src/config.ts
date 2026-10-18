import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  COUNTDOWN_STYLES,
  PROGRESS_STYLES,
  TEMPERATURE_SENSORS,
  type CountdownStyle,
  type ProgressStyle,
  type TemperatureSensor,
} from './homekit/display.ts';
import type { Layout } from './homekit/printer-accessory.ts';
import type { PrinterConnection } from './printer/client.ts';

export interface PrinterConfig extends PrinterConnection {
  /** Shown as the HomeKit model, e.g. "H2C". */
  model?: string;
}

export interface BridgeConfig {
  name: string;
  port: number;
  /** Interfaces or addresses to serve and advertise on; all when absent. */
  bind?: string[];
}

export interface DisplayConfig {
  progress: ProgressStyle[];
  countdown: CountdownStyle[];
  temperatures: TemperatureSensor[];
  layout: Layout;
}

export interface Config {
  printers: PrinterConfig[];
  /** Pairing keys and certificate pins live here. */
  storagePath: string;
  bridge: BridgeConfig;
  display: DisplayConfig;
}

export const DEFAULT_PORT = 51827;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${where} must be a non-empty string`);
  return value.trim();
}

function requirePort(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${where} must be an integer between 1 and 65535`);
  }
  return value;
}

function readAccessCode(entry: Raw, where: string, baseDir: string): string {
  const inline = entry['accessCode'];
  const file = entry['accessCodeFile'];
  if (inline !== undefined && file !== undefined) {
    throw new ConfigError(`${where}: set accessCode or accessCodeFile, not both`);
  }
  if (file !== undefined) {
    const path = resolve(baseDir, requireString(file, `${where}.accessCodeFile`));
    let code: string;
    try {
      code = readFileSync(path, 'utf8').trim();
    } catch (error) {
      throw new ConfigError(`${where}.accessCodeFile: cannot read ${path} (${(error as Error).message})`);
    }
    if (code === '') throw new ConfigError(`${where}.accessCodeFile: ${path} is empty`);
    return code;
  }
  return requireString(inline, `${where}.accessCode`);
}

function pickList<T extends string>(value: unknown, allowed: readonly T[], fallback: T[], where: string): T[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new ConfigError(`${where} must be an array of ${allowed.join(' | ')}`);
  const picked: T[] = [];
  for (const item of value) {
    if (!allowed.includes(item as T)) throw new ConfigError(`${where}: unknown value ${JSON.stringify(item)} (allowed: ${allowed.join(', ')})`);
    if (picked.includes(item as T)) throw new ConfigError(`${where}: ${String(item)} listed twice`);
    picked.push(item as T);
  }
  return picked;
}

function parsePrinter(item: unknown, index: number, baseDir: string): PrinterConfig {
  const where = `printers[${index}]`;
  if (!isRaw(item)) throw new ConfigError(`${where} must be an object`);
  const printer: PrinterConfig = {
    name: requireString(item['name'], `${where}.name`),
    host: requireString(item['host'], `${where}.host`),
    port: requirePort(item['port'] ?? 8883, `${where}.port`),
    serial: requireString(item['serial'], `${where}.serial`),
    accessCode: readAccessCode(item, where, baseDir),
  };
  if (item['model'] !== undefined) printer.model = requireString(item['model'], `${where}.model`);
  return printer;
}

function parseBridge(value: unknown): BridgeConfig {
  if (value === undefined) return { name: 'bamboozle', port: DEFAULT_PORT };
  if (!isRaw(value)) throw new ConfigError('bridge must be an object');
  const bridge: BridgeConfig = {
    name: requireString(value['name'] ?? 'bamboozle', 'bridge.name'),
    port: requirePort(value['port'] ?? DEFAULT_PORT, 'bridge.port'),
  };
  const bind = value['bind'];
  if (bind !== undefined) {
    if (!Array.isArray(bind) || bind.length === 0) throw new ConfigError('bridge.bind must be a non-empty array of interfaces or addresses');
    bridge.bind = bind.map((entry, i) => requireString(entry, `bridge.bind[${i}]`));
  }
  return bridge;
}

function parseDisplay(value: unknown): DisplayConfig {
  if (value !== undefined && !isRaw(value)) throw new ConfigError('display must be an object');
  const raw = value ?? {};
  const layout = raw['layout'] ?? 'grouped';
  if (layout !== 'grouped' && layout !== 'separate') throw new ConfigError('display.layout must be "grouped" or "separate"');
  return {
    progress: pickList(raw['progress'], PROGRESS_STYLES, ['fan'], 'display.progress'),
    countdown: pickList(raw['countdown'], COUNTDOWN_STYLES, [], 'display.countdown'),
    temperatures: pickList(raw['temperatures'], TEMPERATURE_SENSORS, ['chamber'], 'display.temperatures'),
    layout,
  };
}

export function parseConfig(raw: unknown, baseDir: string): Config {
  if (!isRaw(raw)) throw new ConfigError('config must be a JSON object');

  const list = raw['printers'];
  if (!Array.isArray(list) || list.length === 0) throw new ConfigError('printers must be a non-empty array');
  const printers = list.map((item, index) => parsePrinter(item, index, baseDir));

  const serials = new Set<string>();
  for (const printer of printers) {
    if (serials.has(printer.serial)) throw new ConfigError(`duplicate printer serial ${printer.serial}`);
    serials.add(printer.serial);
  }

  const storage = raw['storagePath'] ?? 'storage';
  return {
    printers,
    storagePath: resolve(baseDir, requireString(storage, 'storagePath')),
    bridge: parseBridge(raw['bridge']),
    display: parseDisplay(raw['display']),
  };
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`cannot read config ${path}: ${(error as Error).message}`);
  }
  return parseConfig(raw, dirname(resolve(path)));
}
