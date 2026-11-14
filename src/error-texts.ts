import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomically } from './homekit/pairing-storage.ts';
import { isObject } from './printer/merge.ts';

// What an HMS code or a print error means, for the camera overlay.
//
// Bambu publishes these texts per printer model, keyed by the first three
// characters of the serial. bamboozle does not ship them (they are Bambu's,
// and they change with every firmware), and the bridge itself never goes on
// the internet: `bamboozle error-texts` downloads the table for each
// configured model into storagePath/error-texts/, and the running bridge
// reads it from there. Bambu leaves some codes without text; custom.json in
// the same folder adds texts of your own, or replaces Bambu's.

export const ERROR_TEXTS_DIR = 'error-texts';
export const CUSTOM_FILE = 'custom.json';
const BAMBU_URL = 'https://e.bambulab.com/query.php';

export type CodeKind = 'hms' | 'error';

/** Bambu's model key: the first three characters of the serial ("31B" for an H2C). */
export function modelPrefix(serial: string): string {
  return serial.slice(0, 3).toUpperCase();
}

export function bambuFileName(prefix: string): string {
  return `bambu-${prefix}.json`;
}

/**
 * A code as written by a person or by Bambu ("0C00_0300_0002_000D",
 * "0c00-8040", "0C008040"): 16 hex digits are an HMS code, 8 a print error.
 */
export function codeKey(code: string): { kind: CodeKind; key: string } | null {
  const hex = code.replace(/[\s_-]/g, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(hex)) return null;
  if (hex.length === 16) return { kind: 'hms', key: hex };
  if (hex.length === 8) return { kind: 'error', key: hex };
  return null;
}

// The overlay font (Hermit) has no CJK glyphs and drawtext has no fallback
// font. Bambu's English texts carry a few CJK clause marks (they become the
// ASCII mark and a space), typographic quotes and signs; NFKC turns
// full-width letters and marks like the degree-Celsius sign into plain ones,
// and accents are stripped rather than letting the letter vanish. Anything
// else outside ASCII and the degree sign would draw as an empty box, so it is
// dropped. Keyed by code point so the source itself stays free of CJK.
const PUNCTUATION = new Map<number, string>([
  [0x3001, ', '], // IDEOGRAPHIC COMMA
  [0x3002, '. '], // IDEOGRAPHIC FULL STOP
  [0xff0c, ', '], // FULLWIDTH COMMA
  [0xff1a, ': '], // FULLWIDTH COLON
  [0xff1b, '; '], // FULLWIDTH SEMICOLON
  [0xff01, '! '], // FULLWIDTH EXCLAMATION MARK
  [0xff1f, '? '], // FULLWIDTH QUESTION MARK
  [0x2018, "'"], // LEFT SINGLE QUOTATION MARK
  [0x2019, "'"], // RIGHT SINGLE QUOTATION MARK
  [0x201c, '"'], // LEFT DOUBLE QUOTATION MARK
  [0x201d, '"'], // RIGHT DOUBLE QUOTATION MARK
  [0x2013, '-'], // EN DASH
  [0x2014, '-'], // EM DASH
  [0x2192, '->'], // RIGHTWARDS ARROW
  [0x2265, '>='], // GREATER-THAN OR EQUAL TO
  [0x2264, '<='], // LESS-THAN OR EQUAL TO
  [0x00d7, 'x'], // MULTIPLICATION SIGN
  [0x00b1, '+/-'], // PLUS-MINUS SIGN
]);

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** One line of text the overlay font can draw; '' when nothing readable is left. */
export function drawableText(text: string): string {
  // Mapped before and after NFKC: its compatibility forms (half-width,
  // small, vertical) only become the listed marks there.
  const map = (input: string) => Array.from(input, (char) => PUNCTUATION.get(char.codePointAt(0)!) ?? char).join('');
  // A mu right after a number is the micro prefix ("50 um"); NFKC turns the
  // micro sign into one. Anywhere else it is Greek, and dropped below.
  const plain = map(map(text).normalize('NFKC'))
    .replace(/(?<=\d\s?)\u03bc/g, 'u')
    .normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC');
  let out = '';
  for (const char of plain) {
    if (/^[\x20-\x7E°]$/.test(char)) out += char;
    else if (/\s/.test(char)) out += ' ';
  }
  out = out.replace(/\s+/g, ' ').trim();
  return /[A-Za-z0-9]/.test(out) ? out : '';
}

// --- Bambu's table -------------------------------------------------------------

export interface BambuTable {
  /** Bambu's version stamp of the table. */
  version: string;
  /** HMS code (16 hex digits) → text. */
  hms: Record<string, string>;
  /** Print error (8 hex digits) → text. */
  errors: Record<string, string>;
}

function entries(list: unknown, digits: number): Record<string, string> {
  if (!Array.isArray(list)) return {};
  const texts: Record<string, string> = {};
  for (const entry of list) {
    if (!isObject(entry) || typeof entry['ecode'] !== 'string' || typeof entry['intro'] !== 'string') continue;
    const code = codeKey(entry['ecode']);
    // Bambu lists codes it keeps to itself with an empty text: skip those.
    if (!code || code.key.length !== digits || entry['intro'].trim() === '') continue;
    texts[code.key] = entry['intro'];
  }
  return texts;
}

/** Reads the answer of Bambu's query.php; throws when it is not a table. */
export function parseBambuAnswer(answer: unknown): BambuTable {
  if (!isObject(answer)) throw new Error('the answer is not a JSON object');
  if (answer['result'] !== 0) throw new Error(`Bambu answered with result ${JSON.stringify(answer['result'])} (an unknown printer model?)`);
  const data = answer['data'];
  if (!isObject(data)) throw new Error('the answer has no texts');
  const hmsList = isObject(data['device_hms']) ? data['device_hms'] : {};
  const errorList = isObject(data['device_error']) ? data['device_error'] : {};
  const hms = entries(hmsList['en'], 16);
  const errors = entries(errorList['en'], 8);
  if (Object.keys(hms).length === 0 && Object.keys(errors).length === 0) throw new Error('the answer has no texts');
  return { version: String(hmsList['ver'] ?? errorList['ver'] ?? answer['ver'] ?? ''), hms, errors };
}

function bambuUrl(prefix: string, base = BAMBU_URL): string {
  const url = new URL(base);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('d', prefix);
  return url.toString();
}

// The 2026 tables are well under 1 MB; anything this large is not one.
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

export interface DownloadOptions {
  /** Instead of Bambu's server (tests). */
  base?: string;
  maxBytes?: number;
}

/** Downloads one model's English table from `url`. */
async function downloadBambuTable(url: string, maxBytes: number): Promise<BambuTable> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url} answered HTTP ${response.status}`);
  }
  // Counted while it arrives, so an endless answer stops at the limit.
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      // Leaving the loop by throwing cancels the body.
      if (bytes > maxBytes) throw new Error(`${url} sent more than ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    throw new Error(`${url} did not answer with JSON`);
  }
  return parseBambuAnswer(answer);
}

/** Writes a table where the bridge looks for it, atomically; returns the path. */
export function saveBambuTable(dir: string, prefix: string, table: BambuTable, source: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, bambuFileName(prefix));
  writeAtomically(target, `${JSON.stringify({ source, version: table.version, downloaded: new Date().toISOString(), hms: table.hms, errors: table.errors }, null, 1)}\n`);
  return target;
}

// --- lookup ----------------------------------------------------------------------

type Texts = Map<string, string>; // `${kind}:${key}` → drawable text ('' = show no text)

interface Loaded {
  /** mtime + size of what was read, '' when the file is missing. */
  signature: string;
  texts: Texts;
}

function readBambu(raw: unknown): { texts: Texts; ignored: number } {
  if (!isObject(raw) || !isObject(raw['hms']) || !isObject(raw['errors'])) throw new Error('not a table written by "bamboozle error-texts"');
  const texts: Texts = new Map();
  let ignored = 0;
  for (const [kind, list] of [['hms', raw['hms']], ['error', raw['errors']]] as const) {
    for (const [code, text] of Object.entries(list)) {
      const key = codeKey(code);
      const drawn = typeof text === 'string' ? drawableText(text) : '';
      if (key?.kind === kind && drawn) texts.set(`${kind}:${key.key}`, drawn);
      else ignored++;
    }
  }
  return { texts, ignored };
}

function readCustom(raw: unknown): { texts: Texts; ignored: number } {
  if (!isObject(raw)) throw new Error('expected an object of code → text');
  const texts: Texts = new Map();
  let ignored = 0;
  for (const [code, text] of Object.entries(raw)) {
    const key = codeKey(code);
    if (!key || typeof text !== 'string') {
      ignored++;
      continue;
    }
    // An empty text hides Bambu's for that code; a text with nothing the
    // overlay can draw (another script) is a mistake, not a wish to hide.
    const drawn = drawableText(text);
    if (text.trim() !== '' && !drawn) ignored++;
    else texts.set(`${key.kind}:${key.key}`, drawn);
  }
  return { texts, ignored };
}

export interface ErrorTextsOptions {
  /** How often the files are checked for changes while texts are asked for (default 60 s). */
  recheckMs?: number;
  clock?: () => number;
  warn?: (message: string) => void;
  readFile?: (path: string) => string;
  stat?: (path: string) => { mtimeMs: number; size: number; isFile(): boolean };
}

/**
 * The texts for one printer: custom.json first, then Bambu's table for its
 * model. Files are read on first use and re-read when they change (checked
 * at most every recheckMs, and only while an alert asks for a text), so a
 * new download or edit shows without a restart. A missing file means no
 * texts; a broken one is reported once and ignored until it changes.
 */
export class ErrorTexts {
  readonly #dir: string;
  readonly #bambuFile: string;
  readonly #recheckMs: number;
  readonly #clock: () => number;
  readonly #warn: (message: string) => void;
  readonly #readFile: (path: string) => string;
  readonly #stat: NonNullable<ErrorTextsOptions['stat']>;
  #checkedAt = Number.NEGATIVE_INFINITY;
  readonly #loaded = new Map<string, Loaded>();
  /** File name → signature of the version that could not be read, to report it once. */
  readonly #unreadable = new Map<string, string>();

  constructor(dir: string, prefix: string, options: ErrorTextsOptions = {}) {
    this.#dir = dir;
    this.#bambuFile = bambuFileName(prefix);
    this.#recheckMs = options.recheckMs ?? 60_000;
    // Monotonic: a wall clock set back would stop the rechecks.
    this.#clock = options.clock ?? (() => performance.now());
    this.#warn = options.warn ?? (() => {});
    this.#readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
    this.#stat = options.stat ?? ((path) => statSync(path));
  }

  /**
   * Whether Bambu's table for this printer's model is there (readable or
   * not); one that cannot even be looked at is reported now, not at the
   * first alert.
   */
  hasBambuTable(): boolean {
    const path = join(this.#dir, this.#bambuFile);
    try {
      return this.#stat(path).isFile();
    } catch (error) {
      if (missing(error)) return false;
      this.#cannotRead(this.#bambuFile, path, `stat:${(error as NodeJS.ErrnoException).code}`, error);
      return true;
    }
  }

  explain(kind: CodeKind, key: string): string | undefined {
    const now = this.#clock();
    if (now - this.#checkedAt >= this.#recheckMs) {
      this.#checkedAt = now;
      this.#refresh(CUSTOM_FILE, readCustom);
      this.#refresh(this.#bambuFile, readBambu);
    }
    const id = `${kind}:${key}`;
    const custom = this.#loaded.get(CUSTOM_FILE)?.texts.get(id);
    if (custom !== undefined) return custom || undefined;
    return this.#loaded.get(this.#bambuFile)?.texts.get(id);
  }

  // Not remembered as loaded: a fixed owner or mode changes neither mtime nor
  // size, so the next check tries again. Reported once per failure.
  #cannotRead(name: string, path: string, failure: string, error: unknown): void {
    if (this.#unreadable.get(name) !== failure) {
      this.#unreadable.set(name, failure);
      this.#warn(`${path} cannot be read, the overlay shows codes without its texts: ${(error as Error).message}`);
    }
    this.#loaded.set(name, { signature: 'unreadable', texts: new Map() });
  }

  #refresh(name: string, read: (raw: unknown) => { texts: Texts; ignored: number }): void {
    const path = join(this.#dir, name);
    let signature = '';
    try {
      const stat = this.#stat(path);
      signature = `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      // A folder the bridge may not enter is not a missing file.
      if (!missing(error)) return this.#cannotRead(name, path, `stat:${(error as NodeJS.ErrnoException).code}`, error);
    }
    // Gone in between: the same failure coming back is news again.
    if (!signature) this.#unreadable.delete(name);
    const previous = this.#loaded.get(name);
    if (previous && previous.signature === signature) return;
    let texts: Texts = new Map();
    if (signature) {
      let content: string;
      try {
        content = this.#readFile(path);
      } catch (error) {
        return this.#cannotRead(name, path, signature, error);
      }
      this.#unreadable.delete(name);
      try {
        const result = read(JSON.parse(content));
        texts = result.texts;
        if (result.ignored > 0) this.#warn(`${path}: ignored ${result.ignored} entr${result.ignored === 1 ? 'y' : 'ies'} (not a code, or no text the overlay can draw)`);
      } catch (error) {
        this.#warn(`${path} cannot be used, the overlay shows codes without its texts: ${(error as Error).message}`);
      }
    }
    this.#loaded.set(name, { signature, texts });
  }
}

// fetch() says only "fetch failed"; why (DNS, refused, certificate) is in its
// cause, which for a host with several addresses is an AggregateError whose
// own message is empty.
function causeText(cause: unknown): string {
  if (!(cause instanceof Error)) return '';
  const first = (cause as Error & { errors?: unknown[] }).errors?.[0];
  return cause.message || (first instanceof Error ? first.message : '') || String((cause as NodeJS.ErrnoException).code ?? '');
}

/**
 * `bamboozle error-texts`: download Bambu's table for every printer model in
 * the config. Returns whether every model got its table; a model that fails
 * keeps the table it had.
 */
export async function updateErrorTexts(
  printers: ReadonlyArray<{ name: string; serial: string }>,
  storagePath: string,
  options: DownloadOptions & { log?: Pick<Console, 'log' | 'error'> } = {},
): Promise<boolean> {
  const log = options.log ?? console;
  const dir = join(storagePath, ERROR_TEXTS_DIR);
  const models = new Map<string, string[]>();
  for (const printer of printers) {
    const prefix = modelPrefix(printer.serial);
    models.set(prefix, [...(models.get(prefix) ?? []), printer.name]);
  }
  let ok = true;
  for (const [prefix, names] of models) {
    const label = `${names.join(', ')} (model ${prefix})`;
    try {
      const source = bambuUrl(prefix, options.base);
      const table = await downloadBambuTable(source, options.maxBytes ?? MAX_ANSWER_BYTES);
      const path = saveBambuTable(dir, prefix, table, source);
      log.log(`${label}: ${Object.keys(table.hms).length} HMS texts and ${Object.keys(table.errors).length} print error texts, version ${table.version || 'unknown'}, saved to ${path}`);
    } catch (error) {
      ok = false;
      const { message, cause } = error as Error;
      const why = causeText(cause);
      log.error(`${label}: no texts downloaded: ${message}${why ? ` (${why})` : ''}`);
    }
  }
  return ok;
}
