import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrinterStatus } from '../printer/status.ts';

// The status overlay drawn on the camera image, for snapshots and live video.
//
// ffmpeg's drawtext re-reads a text file every frame (reload=1), so every
// changing element is one drawtext layer bound to one file: bamboozle writes
// the files, ffmpeg picks the change up mid-stream. Colours cannot change at
// runtime, so a coloured element exists once per colour and only the active
// colour's file is non-empty. The layout is fixed on a 1280x720 canvas and
// scaled to whatever size the Home app asks for.

export const CANVAS = { width: 1280, height: 720 } as const;
const MARGIN = 40;

/** Hermit's advance width in em (monospace: digits, letters, blocks). */
const ADVANCE = 0.617;
const ASCENT = 0.75;

const COLORS = {
  green: '0x30D158',
  blue: '0x0A84FF',
  yellow: '0xFFD60A',
  red: '0xFF453A',
  grey: '0x8E8E93',
} as const;
type Tone = keyof typeof COLORS;

type Weight = 'bold' | 'medium';

interface Layer {
  file: string;
  weight: Weight;
  size: number;
  color: string;
  /** ffmpeg expression; w, h, tw are available. */
  x: string;
  y: string;
  box?: { color: string; border: number };
  shadow?: boolean;
}

// --- layout ----------------------------------------------------------------

const PILL_SIZE = 24;
const BIG_SIZE = 112;
const VALUE_SIZE = 44;
const CAPTION_SIZE = 26;
const DETAIL_SIZE = 22;
// 13 px makes the block advance ~8.02 px, close to whole pixels, so adjacent
// blocks do not leave anti-aliased seams.
const BAR_SIZE = 13;

// Baselines, measured from the bottom edge.
const BIG_BASELINE = CANVAS.height - 104;
const CAPTION_BASELINE = BIG_BASELINE - VALUE_SIZE - 12;
const DETAIL_BASELINE = CANVAS.height - MARGIN;
const BAR_TOP = CANVAS.height - 86;

const top = (baseline: number, size: number) => String(Math.round(baseline - ASCENT * size));

export const BAR_SLOTS = Math.floor((CANVAS.width - 2 * MARGIN) / (ADVANCE * BAR_SIZE));

// Detail line columns, in characters of the monospace detail font.
const DETAIL_COLUMNS = [
  { key: 'layer', label: 'LAYER', at: 0, value: 6 },
  { key: 'nozzle', label: 'NOZZLE', at: 16, value: 23 },
  { key: 'bed', label: 'BED', at: 30, value: 34 },
  { key: 'chamber', label: 'CHAMBER', at: 41, value: 49 },
] as const;
const column = (chars: number) => String(Math.round(MARGIN + chars * ADVANCE * DETAIL_SIZE));

const TONES = Object.keys(COLORS) as Tone[];

// Block glyphs leave faint anti-aliased seams where their fractional advance
// does not land on whole pixels. Each bar is drawn twice, the copy shifted by
// half a block, so every seam of one copy sits inside a block of the other.
const BAR_SHIFT = Math.round((ADVANCE * BAR_SIZE) / 2);
function barLayers(file: string, color: string): Layer[] {
  return [0, BAR_SHIFT].map((shift) => ({ file, weight: 'medium' as const, size: BAR_SIZE, color, x: String(MARGIN + shift), y: String(BAR_TOP) }));
}

export const LAYERS: readonly Layer[] = [
  // State pill, top left: one layer per colour.
  ...TONES.map((tone) => ({
    file: `pill-${tone}`,
    weight: 'bold' as const,
    size: PILL_SIZE,
    color: tone === 'yellow' ? 'black' : 'white',
    x: String(MARGIN),
    y: '36',
    box: { color: `${COLORS[tone]}@0.95`, border: 12 },
  })),
  // Printer name, top right.
  { file: 'name', weight: 'bold', size: PILL_SIZE, color: 'white', x: `w-tw-${MARGIN}`, y: '36', shadow: true },
  // Alert under the pill (HMS / print error).
  { file: 'alert-yellow', weight: 'medium', size: 18, color: 'black', x: String(MARGIN), y: '92', box: { color: `${COLORS.yellow}@0.95`, border: 8 } },
  { file: 'alert-red', weight: 'medium', size: 18, color: 'white', x: String(MARGIN), y: '92', box: { color: `${COLORS.red}@0.95`, border: 8 } },
  // Big progress, bottom left.
  { file: 'big', weight: 'bold', size: BIG_SIZE, color: 'white', x: String(MARGIN - 4), y: top(BIG_BASELINE, BIG_SIZE) },
  // Time, bottom right: dim caption above, bright value on the big baseline.
  { file: 'caption', weight: 'medium', size: CAPTION_SIZE, color: 'white@0.82', x: `w-tw-${MARGIN}`, y: top(CAPTION_BASELINE, CAPTION_SIZE) },
  { file: 'value', weight: 'bold', size: VALUE_SIZE, color: 'white', x: `w-tw-${MARGIN}`, y: top(BIG_BASELINE, VALUE_SIZE) },
  // Progress bar: opaque track, fill in the state colour.
  ...barLayers('bar-track', '0x3A3A3C'),
  ...TONES.flatMap((tone) => barLayers(`bar-${tone}`, COLORS[tone])),
  // Detail line: dim labels and bright values on fixed monospace columns.
  ...DETAIL_COLUMNS.flatMap((c) => [
    { file: `detail-${c.key}-label`, weight: 'medium' as const, size: DETAIL_SIZE, color: 'white@0.55', x: column(c.at), y: top(DETAIL_BASELINE, DETAIL_SIZE) },
    { file: `detail-${c.key}`, weight: 'medium' as const, size: DETAIL_SIZE, color: 'white@0.95', x: column(c.value), y: top(DETAIL_BASELINE, DETAIL_SIZE) },
  ]),
];

export const LAYER_FILES: readonly string[] = [...new Set(LAYERS.map((layer) => layer.file))];

// Soft gradients behind the text, built from thin bands whose opacity
// follows an easing curve (steps of ~0.02 alpha do not show as stripes).
// ffmpeg's gradients source cannot be made static (its rotation speed has a
// non-zero minimum), and a looped overlay image is not re-read, so bands it is.
const BAND = 10;
function ramp(count: number, max: number, exponent: number): number[] {
  return Array.from({ length: count }, (_, i) => Number((max * Math.pow((i + 1) / count, exponent)).toFixed(3)));
}
const BOTTOM_BANDS = ramp(30, 0.74, 1.6); // top of the band → bottom edge, darkening
const TOP_BANDS = ramp(12, 0.45, 1.4).reverse(); // top edge → down, fading out

// --- content ---------------------------------------------------------------

export interface OverlayInput {
  status: PrinterStatus | null;
  available: boolean;
  name: string;
  now: Date;
  /** When the current job was seen finishing, if bamboozle saw it. */
  finishedAt: Date | null;
  /** IANA zone for clock times; the host's zone when absent. */
  timeZone?: string;
}

export type OverlayContent = Record<string, string>;

/** "26m", "1h 26m", "2h", "24h 20m": hours never roll into days. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function clock(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(date);
}

function day(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(date);
}

function weekday(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', ...(timeZone ? { timeZone } : {}) }).format(date).toUpperCase();
}

/** "05:18" today, "TUE 05:18" on another day. */
export function formatClock(target: Date, now: Date, timeZone?: string): string {
  const time = clock(target, timeZone);
  return day(target, timeZone) === day(now, timeZone) ? time : `${weekday(target, timeZone)} ${time}`;
}

function bar(fraction: number): string {
  return '█'.repeat(Math.round(Math.min(1, Math.max(0, fraction)) * BAR_SLOTS));
}

function degrees(value: number | undefined | null): string {
  return value === null || value === undefined ? '' : `${Math.round(value)}°`;
}

function empty(): OverlayContent {
  return Object.fromEntries(LAYER_FILES.map((file) => [file, '']));
}

const STATE_LOOK: Record<PrinterStatus['state'] | 'offline', { tone: Tone; label: string }> = {
  printing: { tone: 'green', label: 'PRINTING' },
  preparing: { tone: 'blue', label: 'PREPARING' },
  paused: { tone: 'yellow', label: 'PAUSED' },
  finished: { tone: 'blue', label: 'FINISHED' },
  failed: { tone: 'red', label: 'FAILED' },
  idle: { tone: 'grey', label: 'IDLE' },
  unknown: { tone: 'grey', label: 'IDLE' },
  offline: { tone: 'grey', label: 'OFFLINE' },
};

function alert(status: PrinterStatus): { tone: 'yellow' | 'red'; text: string } | null {
  if (status.printError !== 0) {
    const hex = (status.printError >>> 0).toString(16).toUpperCase().padStart(8, '0');
    return { tone: 'red', text: `ERROR ${hex.slice(0, 4)}_${hex.slice(4)}` };
  }
  const shown = status.hms.filter((entry) => entry.severity === 'fatal' || entry.severity === 'serious');
  const first = shown[0];
  if (!first) return null;
  const more = shown.length > 1 ? ` +${shown.length - 1}` : '';
  return { tone: first.severity === 'fatal' ? 'red' : 'yellow', text: `HMS ${first.code}${more}` };
}

/** What every overlay layer shows for the given printer state. */
export function overlayContent(input: OverlayInput): OverlayContent {
  const content = empty();
  const { status, available, timeZone, now } = input;
  content['name'] = input.name.replace(/[\r\n]+/g, ' ');

  if (!available || status === null) {
    content['pill-grey'] = `● ${STATE_LOOK.offline.label}`;
    return content;
  }

  const look = STATE_LOOK[status.state];
  content[`pill-${look.tone}`] = `● ${look.label}`;

  const warning = alert(status);
  if (warning) content[`alert-${warning.tone}`] = warning.text;

  const progress = Math.min(100, Math.max(0, Math.round(status.progress ?? 0)));
  const remaining = Math.max(0, Math.round(status.remainingMinutes ?? 0));
  const showsJob = status.state !== 'idle' && status.state !== 'unknown';

  if (showsJob) {
    content['big'] = `${status.state === 'finished' ? 100 : progress}%`;
    content['bar-track'] = bar(1);
    content[`bar-${look.tone}`] = bar(status.state === 'finished' ? 1 : progress / 100);
  }

  switch (status.state) {
    case 'printing':
    case 'preparing':
      if (remaining > 0) {
        content['value'] = `${formatDuration(remaining)} left`;
        content['caption'] = `ETA ${formatClock(new Date(now.getTime() + remaining * 60_000), now, timeZone)}`;
      } else if (status.state === 'preparing') {
        content['value'] = 'Starting';
      }
      break;
    case 'paused':
      if (remaining > 0) content['value'] = `${formatDuration(remaining)} left`;
      content['caption'] = 'ON HOLD';
      break;
    case 'finished':
      content['value'] = input.finishedAt ? `Done ${formatClock(input.finishedAt, now, timeZone)}` : 'Done';
      break;
    case 'failed':
      content['value'] = 'Stopped';
      break;
    default:
      break;
  }

  if (showsJob && status.layer !== null && status.totalLayers) {
    content['detail-layer-label'] = 'LAYER';
    content['detail-layer'] = `${status.layer}/${status.totalLayers}`;
  }
  const temps: Array<[string, string, number | undefined]> = [
    ['nozzle', 'NOZZLE', status.nozzle?.current],
    ['bed', 'BED', status.bed?.current],
    ['chamber', 'CHAMBER', status.chamber?.current],
  ];
  for (const [key, label, value] of temps) {
    if (value === undefined) continue;
    content[`detail-${key}-label`] = label;
    content[`detail-${key}`] = degrees(value);
  }
  return content;
}

// --- files -------------------------------------------------------------------

// Characters that would need escaping inside an ffmpeg filter graph.
const UNSAFE_PATH = /[':\\,;[\]=]/;

export function assertFilterSafePath(path: string): void {
  if (UNSAFE_PATH.test(path)) {
    throw new Error(`path ${JSON.stringify(path)} contains one of ' : \\ , ; [ ] =, which ffmpeg filters cannot take unescaped`);
  }
}

/** Writes the overlay text files, atomically and only when they change. */
export class OverlayFiles {
  readonly dir: string;
  #last: OverlayContent = {};

  constructor(dir: string) {
    assertFilterSafePath(dir);
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Every file must exist before ffmpeg starts.
    this.write(empty(), true);
  }

  path(file: string): string {
    return join(this.dir, `${file}.txt`);
  }

  write(content: OverlayContent, force = false): void {
    for (const file of LAYER_FILES) {
      const text = content[file] ?? '';
      if (!force && this.#last[file] === text) continue;
      const target = this.path(file);
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, target);
      this.#last[file] = text;
    }
  }

  read(file: string): string {
    return readFileSync(this.path(file), 'utf8');
  }
}

// --- filter --------------------------------------------------------------------

export interface OverlayFonts {
  bold: string;
  medium: string;
}

function drawtext(layer: Layer, files: OverlayFiles, fonts: OverlayFonts): string {
  const options = [
    'expansion=none',
    'reload=1',
    `fontfile=${fonts[layer.weight]}`,
    `textfile=${files.path(layer.file)}`,
    `fontsize=${layer.size}`,
    `fontcolor=${layer.color}`,
    `x=${layer.x}`,
    `y=${layer.y}`,
  ];
  if (layer.box) options.push('box=1', `boxcolor=${layer.box.color}`, `boxborderw=${layer.box.border}`);
  if (layer.shadow) options.push('shadowcolor=black@0.6', 'shadowx=0', 'shadowy=2');
  return `drawtext=${options.join(':')}`;
}

/**
 * Filter chain that turns any camera frame into the overlaid 1280x720 canvas:
 * centre-crop to 16:9, scale, darken top and bottom, draw every layer.
 */
export function overlayFilter(files: OverlayFiles, fonts: OverlayFonts): string {
  assertFilterSafePath(fonts.bold);
  assertFilterSafePath(fonts.medium);
  const { width, height } = CANVAS;
  const chain = [`crop='min(iw,ih*16/9)':'min(ih,iw*9/16)'`, `scale=${width}:${height}`];
  BOTTOM_BANDS.forEach((alpha, i) => {
    const y = height - BAND * (BOTTOM_BANDS.length - i);
    chain.push(`drawbox=x=0:y=${y}:w=iw:h=${BAND}:color=black@${alpha}:t=fill`);
  });
  TOP_BANDS.forEach((alpha, i) => chain.push(`drawbox=x=0:y=${i * BAND}:w=iw:h=${BAND}:color=black@${alpha}:t=fill`));
  for (const layer of LAYERS) chain.push(drawtext(layer, files, fonts));
  return chain.join(',');
}
