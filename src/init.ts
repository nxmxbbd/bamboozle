import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ConfigError, parseConfig, parseJson } from './config.ts';
import { openToEveryone } from './paths.ts';
import { isPrinterSerial } from './printer/serial.ts';

export interface InitOptions {
  configPath: string;
  /** Printer address given on the command line (otherwise asked). */
  host?: string;
  /** Name in the Home app given on the command line (otherwise asked). */
  name?: string;
  /** Camera relay URL given on the command line ('' = none; otherwise asked). */
  camera?: string;
  /** Set the printer up again in an existing config; everything else in it, the pairing too, is kept. */
  force: boolean;
  /** How to start the bridge with this config, for the closing hint. */
  serveCommand: string;
}

export interface InitIO {
  /** Ask one question; an empty answer resolves ''. Hidden answers are not echoed. */
  ask(question: string, hidden?: boolean): Promise<string>;
  say(line: string): void;
  readSerial(host: string): Promise<string>;
  probe(configPath: string): Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
}

export const ACCESS_CODE_FILE = 'printer.code';
const DEFAULT_NAME = '3D Printer';
const TRIES = 3;

/** A path as a shell word, for hints people copy. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * How to start the bridge, for the closing hint: with the --config init was
 * given, else what $BAMBOOZLE_SERVE_HINT says (the container image points at
 * its compose commands), else plain "bamboozle serve".
 */
export function serveHint(configFlag: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (configFlag !== undefined) return `bamboozle serve --config ${shellWord(configFlag)}`;
  return env['BAMBOOZLE_SERVE_HINT']?.trim() || 'bamboozle serve';
}

/** Write a file only its owner can read; an existing file is narrowed before the new content lands. */
function writePrivate(path: string, content: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, content, { mode: 0o600 });
}

/**
 * Throw (with mkdir's or access's error code) unless `dir` could be created
 * and written, without creating anything: the nearest existing ancestor
 * must be a directory this process can write.
 */
function assertWritable(dir: string): void {
  // lstat, so a dangling or looping symlink counts as there: following it
  // (stat below) then fails with its real error instead of walking past it.
  const there = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  let existing = dir;
  while (!there(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (!statSync(existing).isDirectory()) throw Object.assign(new Error(`${existing} is not a directory`), { code: 'ENOTDIR' });
  accessSync(existing, constants.W_OK);
}

/** What init --force keeps: every setting but the printers, and the one printer it replaces. */
interface Kept {
  settings: Record<string, unknown>;
  previous?: Record<string, unknown>;
}

/**
 * For --force: everything in the old config but its printers, so the
 * pairing location (storagePath) and the bridge, display and camera
 * settings survive, plus the old printer for its name and camera URL. A
 * file that cannot be read or parsed, settings that do not check out, or
 * several printers (init sets up one) stop init before it asks anything
 * (null): starting over would quietly drop a custom storagePath.
 */
function keptSettings(configPath: string, io: InitIO): Kept | null {
  const leave = (why: string) => {
    io.say(`${why}. Fix it, or remove it to start over; nothing was changed.`);
    return null;
  };
  let raw: unknown;
  try {
    raw = parseJson(readFileSync(configPath, 'utf8'), configPath);
  } catch (error) {
    if (error instanceof ConfigError) return leave(error.message);
    return leave(`Cannot read the existing config ${configPath} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return leave(`The config at ${configPath} is not a JSON object`);
  const { printers, ...settings } = raw as Record<string, unknown>;
  if (Array.isArray(printers) && printers.length > 1) {
    io.say(`The config at ${configPath} has ${printers.length} printers, and init sets up only one. Edit that file by hand instead; nothing was changed.`);
    return null;
  }
  try {
    // The printer is about to be replaced, so a stand-in checks the rest.
    parseConfig({ ...settings, printers: [{ name: 'x', host: 'x', serial: 'X', accessCode: 'x' }] }, dirname(configPath));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return leave(`The settings in ${configPath} do not work: ${error.message}`);
  }
  const first: unknown = Array.isArray(printers) ? printers[0] : undefined;
  const previous = typeof first === 'object' && first !== null && !Array.isArray(first) ? (first as Record<string, unknown>) : undefined;
  return previous ? { settings, previous } : { settings };
}

/** A typed serial, checked like the one from the certificate: it ends up in file names. */
async function askSerial(io: InitIO): Promise<string> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const serial = (await required(io, 'Printer serial number (printer screen, device info): ')).toUpperCase();
    if (isPrinterSerial(serial)) return serial;
    if (attempt < TRIES - 1) io.say('A serial is 8 to 20 letters and digits.');
  }
  throw new Error('no serial: a serial is 8 to 20 letters and digits');
}

async function required(io: InitIO, question: string, hidden = false): Promise<string> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const answer = (await io.ask(question, hidden)).trim();
    if (answer) return answer;
    if (attempt < TRIES - 1) io.say('This one is needed.');
  }
  throw new Error(`no answer to: ${question.trim()}`);
}

/**
 * Write a working config for one printer: ask for the address and the access
 * code, read the serial from the printer's certificate, check everything
 * with the real config parser, write the files (0600), and probe.
 */
export async function init(options: InitOptions, io: InitIO): Promise<number> {
  const { configPath } = options;
  const dir = dirname(configPath);
  const exists = existsSync(configPath);
  if (exists && !options.force) {
    io.say(`There is already a config at ${configPath}.`);
    io.say('Your Home pairing lives next to it, so init leaves it alone. Edit the file, or run init --force to set up the printer again (the rest of the config and the pairing are kept).');
    return 1;
  }
  const kept = exists ? keptSettings(configPath, io) : { settings: {} };
  if (kept === null) return 1;
  const { settings, previous } = kept;
  // Find out now, not after the questions, whether the files can be written
  // (a container user facing a root-owned mount, say).
  try {
    assertWritable(dir);
  } catch (error) {
    const uid = process.getuid?.();
    const as = uid === undefined ? '' : `, running as uid ${uid}`;
    io.say(`Cannot write to ${dir} (${(error as NodeJS.ErrnoException).code ?? 'error'}${as}). Make it writable for that user, or put the config elsewhere with --config.`);
    return 1;
  }
  // Below a directory anyone may write to (without the sticky bit /tmp has),
  // anyone can swap the config, the code file or the pairing keys: check the
  // config's directory and where the pairing keys live (a kept storagePath).
  const keptStorage = typeof settings['storagePath'] === 'string' && settings['storagePath'].trim() !== '' ? settings['storagePath'].trim() : 'storage';
  for (const place of [dir, resolve(dir, keptStorage)]) {
    const open = openToEveryone(place);
    if (open) {
      io.say(`${open} is writable by every user on this machine, so anyone could swap the config, the access code or the pairing keys. Run chmod 700 on it (or at least chmod o-w), then init again.`);
      return 1;
    }
  }

  const host = options.host?.trim() || (await required(io, 'Printer IP address (printer screen, network / LAN settings): '));
  const code = await required(io, 'LAN access code (same screen; typing is hidden): ', true);
  let serial: string;
  try {
    serial = await io.readSerial(host);
    io.say(`Found the printer: serial ${serial}.`);
  } catch (error) {
    io.say(`Could not read the serial from the printer (${(error as Error).message}).`);
    serial = await askSerial(io);
  }
  // With --force, the old printer's name and camera URL are the defaults.
  const oldName = typeof previous?.['name'] === 'string' && previous['name'].trim() !== '' ? previous['name'].trim() : undefined;
  const oldCamera = previous?.['camera'];
  const oldSource = typeof oldCamera === 'object' && oldCamera !== null && typeof (oldCamera as Record<string, unknown>)['source'] === 'string'
    ? ((oldCamera as Record<string, unknown>)['source'] as string)
    : undefined;
  const defaultName = oldName ?? DEFAULT_NAME;
  const name = options.name?.trim() || (await io.ask(`Name in the Home app [${defaultName}]: `)).trim() || defaultName;
  let camera: string;
  if (options.camera !== undefined) camera = options.camera.trim();
  else if (oldSource !== undefined) {
    const answer = (await io.ask(`Camera relay URL [${oldSource}] ("none" for no camera): `)).trim();
    camera = answer === '' ? oldSource : answer.toLowerCase() === 'none' ? '' : answer;
  } else camera = (await io.ask('Camera relay URL, e.g. rtsp://127.0.0.1:8554/printer (empty for none): ')).trim();

  const printer: Record<string, unknown> = { name, host, serial };
  // The same printer keeps what init does not ask about.
  if (previous && typeof previous['serial'] === 'string' && previous['serial'].toUpperCase() === serial) {
    if (previous['model'] !== undefined) printer['model'] = previous['model'];
    if (previous['port'] !== undefined) printer['port'] = previous['port'];
  }
  if (camera) printer['camera'] = { source: camera };
  // Check with the real parser before writing anything; an inline code stands in for the file.
  try {
    parseConfig({ ...settings, printers: [{ ...printer, accessCode: code }] }, dir);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.say(`That does not work as a config: ${error.message}. Nothing was written.`);
    return 1;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const codeFile = join(dir, ACCESS_CODE_FILE);
  writePrivate(codeFile, `${code}\n`);
  writePrivate(configPath, `${JSON.stringify({ printers: [{ ...printer, accessCodeFile: ACCESS_CODE_FILE }], ...settings }, null, 2)}\n`);
  io.say(`Wrote ${configPath} and ${codeFile} (readable only by you).`);

  const result = await io.probe(configPath);
  if (!result.ok) {
    io.say(`The printer did not send a status yet: ${result.error}`);
    io.say('Check the address and the access code (edit the files above), then try "bamboozle probe".');
    return 1;
  }
  io.say(`The printer answers: ${result.summary}.`);
  io.say(`Next: run "${options.serveCommand}" and scan the code it shows with the iPhone camera.`);
  return 0;
}

/** The bits of a terminal input stream promptLine needs. */
export interface TtyInput {
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
}

/**
 * Read one line from a terminal in raw mode, echoing it ourselves, or not at
 * all for a hidden answer (readline offers no supported way to stop its
 * echo). Backspace edits; escape sequences (arrow keys) are ignored; Ctrl+C,
 * or Ctrl+D on an empty line, cancels.
 */
/** How long an ESC may wait for the rest of its sequence before it counts as the Esc key. */
const LONE_ESC_MS = 100;

export function promptLine(input: TtyInput, output: { write(text: string): unknown }, question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    let done = false;
    // Escape sequences: ESC, then CSI ("[" ... final byte 0x40-0x7e), SS3 ("O" + one byte), or one Alt+key byte.
    let escape: 'none' | 'start' | 'csi' | 'ss3' = 'none';
    // An ESC that ends a read is either the Esc key or the start of a sequence
    // whose rest is still on the way: only time tells, as in a terminal.
    let lone: NodeJS.Timeout | undefined;
    // Every way out (Enter, cancel, an exception here or in setup) restores the terminal, once.
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(lone);
      input.off('data', onData);
      try {
        input.setRawMode(false);
        input.pause();
        output.write('\n');
      } catch {
        // Restoring is best effort; the outcome below is what matters.
      }
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      clearTimeout(lone); // more input: a pending ESC goes on as a sequence
      try {
        for (const ch of chunk) {
          if (done) return;
          // Inside a sequence, a control character ends it and still counts as
          // itself (as terminals do), so Esc then Ctrl+C cancels.
          if (escape !== 'none' && ch >= ' ' && ch !== '\u007f') {
            if (escape === 'start') escape = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
            else if (escape === 'ss3' || (ch >= '@' && ch <= '~')) escape = 'none';
            continue;
          }
          escape = 'none';
          if (ch === '\u001b') {
            escape = 'start';
            continue;
          }
          if (ch === '\r' || ch === '\n') return finish();
          if (ch === '\u0003' || (ch === '\u0004' && value === '')) return finish(new Error('cancelled'));
          if (ch === '\u007f' || ch === '\b') {
            if (value) {
              value = [...value].slice(0, -1).join('');
              if (!hidden) output.write('\b \b');
            }
            continue;
          }
          if (ch < ' ') continue;
          value += ch;
          if (!hidden) output.write(ch);
        }
        if (escape === 'start') {
          lone = setTimeout(() => {
            escape = 'none'; // nothing followed: it was the Esc key
          }, LONE_ESC_MS);
        }
      } catch (error) {
        finish(error as Error);
      }
    };
    try {
      output.write(question);
      input.setEncoding('utf8');
      input.on('data', onData);
      input.setRawMode(true);
      input.resume();
    } catch (error) {
      finish(error as Error);
    }
  });
}

/**
 * Questions on a terminal (raw mode, hidden input for secrets), or one
 * answer per line when stdin is a pipe or a file.
 */
export function terminalIO(
  readSerial: InitIO['readSerial'],
  probe: InitIO['probe'],
): InitIO & { close(): void } {
  const stdin = process.stdin;
  const tty = stdin.isTTY === true;
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let ended = false;
  const rl = tty ? null : createInterface({ input: stdin, terminal: false });
  rl?.on('line', (line) => (waiting.length > 0 ? waiting.shift()?.(line) : lines.push(line)));
  rl?.on('close', () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve('');
  });
  const nextLine = (): Promise<string> =>
    lines.length > 0 ? Promise.resolve(lines.shift() as string) : ended ? Promise.resolve('') : new Promise((resolve) => waiting.push(resolve));

  return {
    async ask(question, hidden = false) {
      if (tty) return promptLine(stdin, process.stdout, question, hidden);
      process.stdout.write(question);
      const answer = await nextLine();
      process.stdout.write(hidden ? '\n' : `${answer}\n`);
      return answer;
    },
    say: (line) => console.log(line),
    readSerial,
    probe,
    close: () => rl?.close(),
  };
}
