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
import type { Encoder } from './camera/ffmpeg.ts';
import type { OverlayFonts } from './camera/overlay.ts';
import type { PrinterConnection } from './printer/client.ts';

export interface PrinterConfig extends PrinterConnection {
  /** Shown as the HomeKit model, e.g. "H2C". */
  model?: string;
  /** Video source for the camera accessory (rtsp://, any ffmpeg URL, or lavfi:<graph>). */
  cameraSource?: string;
}

export interface CameraConfig {
  ffmpeg: string;
  encoder: Encoder;
  vaapiDevice: string;
  /** IANA zone for ETA / finish times on the overlay; the host's when absent. */
  timeZone?: string;
  fonts: Partial<OverlayFonts>;
}

export interface BridgeConfig {
  name: string;
  port: number;
  /** Interfaces or addresses to advertise on (the HAP server itself listens on all); all when absent. */
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
  camera: CameraConfig;
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
  // The serial names files under storagePath (pins, overlay text).
  if (!/^[A-Za-z0-9]+$/.test(printer.serial)) throw new ConfigError(`${where}.serial may contain only letters and digits`);
  if (item['model'] !== undefined) printer.model = requireString(item['model'], `${where}.model`);
  if (item['camera'] !== undefined) {
    if (!isRaw(item['camera'])) throw new ConfigError(`${where}.camera must be an object`);
    printer.cameraSource = parseCameraSource(item['camera']['source'], `${where}.camera.source`);
  }
  return printer;
}

/**
 * Scheme and authority the way ffmpeg splits them (av_url_split): the
 * authority runs to the first "/", "?" or "#", and anything before an "@"
 * in it is sent as credentials.
 */
const CAMERA_URL = /^(rtsp|rtsps|http|https):\/\/([^/?#]*)/i;
const UNSAFE_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/**
 * Camera sources are an allowlist, and messages never echo the source: a
 * URL with credentials (or one ffmpeg would unwrap, such as async:rtsp://…)
 * would put the printer's access code into ffmpeg's command line.
 *
 * The WHATWG URL parser and ffmpeg disagree on some inputs: "rtsp:user:pw@host"
 * has no username for the former but credentials for the latter, and a
 * backslash is a path separator for http only in the former. So the
 * authority is checked as ffmpeg reads it, the URL parser must agree, and
 * the canonical form it produces is what ffmpeg gets.
 */
function parseCameraSource(value: unknown, where: string): string {
  const source = requireString(value, where);
  const allowed = `${where} must be an rtsp://, rtsps://, http:// or https:// URL, an absolute file path, or lavfi:<graph>`;
  if (typeof value === 'string' && UNSAFE_CHARACTERS.test(value)) {
    throw new ConfigError(`${where} may not contain backslashes or control characters`);
  }
  if (source.startsWith('lavfi:')) {
    if (/:\/\/|@/.test(source.slice('lavfi:'.length))) throw new ConfigError(`${where}: a lavfi graph may not reference a URL`);
    return source;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    const authority = CAMERA_URL.exec(source)?.[2];
    if (authority === undefined) throw new ConfigError(allowed);
    if (authority === '') throw new ConfigError(`${where}: the URL has no host`);
    if (authority.includes('@')) {
      throw new ConfigError(
        `${where}: credentials in the URL would be visible in ffmpeg's command line; serve the stream from a local relay such as go2rtc instead`,
      );
    }
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new ConfigError(`${where} is not a valid URL; ${allowed}`);
    }
    if (url.hostname === '') throw new ConfigError(`${where}: the URL has no host`);
    if (url.username || url.password) throw new ConfigError(`${where}: credentials in the URL are not allowed`);
    return url.href;
  }
  if (!source.startsWith('/')) throw new ConfigError(allowed);
  return source;
}

function parseCamera(value: unknown): CameraConfig {
  if (value !== undefined && !isRaw(value)) throw new ConfigError('camera must be an object');
  const raw = value ?? {};
  const encoder = raw['encoder'] ?? 'libx264';
  if (encoder !== 'libx264' && encoder !== 'vaapi') throw new ConfigError('camera.encoder must be "libx264" or "vaapi"');
  const camera: CameraConfig = {
    ffmpeg: requireString(raw['ffmpeg'] ?? 'ffmpeg', 'camera.ffmpeg'),
    encoder,
    vaapiDevice: requireString(raw['vaapiDevice'] ?? '/dev/dri/renderD128', 'camera.vaapiDevice'),
    fonts: {},
  };
  if (raw['timeZone'] !== undefined) {
    const zone = requireString(raw['timeZone'], 'camera.timeZone');
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    } catch {
      throw new ConfigError(`camera.timeZone: unknown time zone ${JSON.stringify(zone)}`);
    }
    camera.timeZone = zone;
  }
  const fonts = raw['fonts'];
  if (fonts !== undefined) {
    if (!isRaw(fonts)) throw new ConfigError('camera.fonts must be an object');
    for (const weight of ['bold', 'medium'] as const) {
      if (fonts[weight] !== undefined) camera.fonts[weight] = requireString(fonts[weight], `camera.fonts.${weight}`);
    }
  }
  return camera;
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
  const layout = raw['layout'] ?? 'separate';
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
    camera: parseCamera(raw['camera']),
  };
}

/** Line of a character offset, for error messages that must not quote the file. */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read config ${path} (${(error as NodeJS.ErrnoException).code ?? 'read error'})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // The parser's message quotes the input around the error, which can be
    // the access code. Report only where it is.
    const message = (error as Error).message;
    const line = /line (\d+)/.exec(message)?.[1] ?? /position (\d+)/.exec(message)?.[1];
    const where = /line \d+/.test(message) ? ` at line ${line}` : line ? ` at line ${lineAt(text, Number(line))}` : '';
    throw new ConfigError(`config ${path} is not valid JSON${where}`);
  }
  return parseConfig(raw, dirname(resolve(path)));
}
