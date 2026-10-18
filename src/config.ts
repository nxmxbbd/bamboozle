import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PrinterConnection } from './printer/client.ts';

export interface Config {
  printers: PrinterConnection[];
  /** Pairing keys and certificate pins live here. */
  storagePath: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${where} must be a non-empty string`);
  return value.trim();
}

function readAccessCode(entry: Record<string, unknown>, where: string, baseDir: string): string {
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

export function parseConfig(raw: unknown, baseDir: string): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  const root = raw as Record<string, unknown>;

  const list = root['printers'];
  if (!Array.isArray(list) || list.length === 0) throw new ConfigError('printers must be a non-empty array');

  const printers = list.map((item, index): PrinterConnection => {
    const where = `printers[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new ConfigError(`${where} must be an object`);
    const entry = item as Record<string, unknown>;
    const port = entry['port'] ?? 8883;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`${where}.port must be an integer between 1 and 65535`);
    }
    return {
      name: requireString(entry['name'], `${where}.name`),
      host: requireString(entry['host'], `${where}.host`),
      port,
      serial: requireString(entry['serial'], `${where}.serial`),
      accessCode: readAccessCode(entry, where, baseDir),
    };
  });

  const serials = new Set<string>();
  for (const printer of printers) {
    if (serials.has(printer.serial)) throw new ConfigError(`duplicate printer serial ${printer.serial}`);
    serials.add(printer.serial);
  }

  const storage = root['storagePath'] ?? 'storage';
  return { printers, storagePath: resolve(baseDir, requireString(storage, 'storagePath')) };
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
