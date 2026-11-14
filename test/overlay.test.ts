import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BAR_SLOTS,
  EXPLANATION_COLUMNS,
  EXPLANATION_LINES,
  LAYER_FILES,
  LAYERS,
  OverlayFiles,
  assertFilterSafePath,
  formatClock,
  formatDuration,
  overlayContent,
  overlayFilter,
  type OverlayInput,
} from '../src/camera/overlay.ts';
import { parseStatus, type PrinterStatus } from '../src/printer/status.ts';
import type { JsonObject } from '../src/printer/merge.ts';

const printing = parseStatus(
  JSON.parse(readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8')) as JsonObject,
);
const now = new Date('2026-10-19T03:32:00+08:00');
const base: Omit<OverlayInput, 'status'> = { available: true, name: 'H2C', now, finishedAt: null, timeZone: 'Australia/Perth' };
const clean: PrinterStatus = { ...printing, hms: [] };
const blocks = (n: number) => '█'.repeat(n);

function nonEmpty(content: Record<string, string>, prefix: string): string[] {
  return Object.entries(content).filter(([k, v]) => k.startsWith(prefix) && v !== '').map(([k]) => k);
}

test('printing: progress, time left, ETA, bar, details, HMS alert', () => {
  const c = overlayContent({ ...base, status: printing });
  assert.equal(c['pill-green'], '● PRINTING');
  assert.equal(c['name'], 'H2C');
  assert.equal(c['big'], '47%');
  assert.equal(c['value'], '1h 26m left');
  assert.equal(c['caption'], 'ETA 04:58');
  assert.equal(c['bar-track'], blocks(BAR_SLOTS));
  assert.equal(c['bar-green'], blocks(Math.round(0.47 * BAR_SLOTS)));
  assert.equal(c['detail-layer'], '24/120');
  assert.equal(c['detail-nozzle'], '265°');
  assert.equal(c['detail-bed'], '100°');
  assert.equal(c['detail-chamber'], '59°');
  assert.equal(c['alert-yellow'], 'HMS 0C00_0300_0002_0012');
  assert.equal(c['alert-red'], '');
});

test('exactly one pill, at most one alert and one bar colour in every state', () => {
  const states: PrinterStatus['state'][] = ['printing', 'preparing', 'paused', 'finished', 'failed', 'idle', 'unknown'];
  for (const state of states) {
    const c = overlayContent({ ...base, status: { ...printing, state, printError: state === 'failed' ? 1 : 0 } });
    assert.equal(nonEmpty(c, 'pill-').length, 1, state);
    assert.ok(nonEmpty(c, 'alert-').length <= 1, state);
    assert.ok(nonEmpty(c, 'bar-').filter((k) => k !== 'bar-track').length <= 1, state);
  }
  const offline = overlayContent({ ...base, status: null, available: false });
  assert.deepEqual(nonEmpty(offline, ''), ['pill-grey', 'name']);
  assert.equal(offline['pill-grey'], '● OFFLINE');
});

test('paused shows time left without an ETA; finished and failed', () => {
  const paused = overlayContent({ ...base, status: { ...clean, state: 'paused' } });
  assert.equal(paused['pill-yellow'], '● PAUSED');
  assert.equal(paused['caption'], 'ON HOLD');
  assert.equal(paused['value'], '1h 26m left');
  assert.equal(paused['bar-yellow'], blocks(Math.round(0.47 * BAR_SLOTS)));

  const finishedAt = new Date('2026-10-19T02:58:00+08:00');
  const finished = overlayContent({ ...base, status: { ...clean, state: 'finished', progress: 99 }, finishedAt });
  assert.equal(finished['big'], '100%');
  assert.equal(finished['value'], 'Done 02:58');
  assert.equal(finished['bar-blue'], blocks(BAR_SLOTS));
  assert.equal(overlayContent({ ...base, status: { ...clean, state: 'finished' } })['value'], 'Done');

  const failed = overlayContent({ ...base, status: { ...clean, state: 'failed', printError: 0x03008008 } });
  assert.equal(failed['pill-red'], '● FAILED');
  assert.equal(failed['alert-red'], 'ERROR 0300_8008');
  assert.equal(failed['value'], 'Stopped');
});

test('idle shows temperatures only', () => {
  const c = overlayContent({ ...base, status: { ...clean, state: 'idle' } });
  assert.equal(c['pill-grey'], '● IDLE');
  for (const key of ['big', 'value', 'caption', 'bar-track', 'detail-layer', 'detail-layer-label']) assert.equal(c[key], '', key);
  assert.equal(c['detail-nozzle'], '265°');
});

test('missing temperatures drop their label too', () => {
  const c = overlayContent({ ...base, status: { ...clean, chamber: null } });
  assert.equal(c['detail-chamber'], '');
  assert.equal(c['detail-chamber-label'], '');
});

test('fatal HMS and multiple alerts', () => {
  const fatal = { code: '0300_0100_0001_0007', severity: 'fatal' as const, attr: 0, rawCode: 0 };
  const serious = { code: '0C00_0300_0002_0012', severity: 'serious' as const, attr: 0, rawCode: 0 };
  const info = { code: '0500_0400_0004_0001', severity: 'info' as const, attr: 0, rawCode: 0 };
  const c = overlayContent({ ...base, status: { ...clean, hms: [fatal, serious, info] } });
  assert.equal(c['alert-red'], 'HMS 0300_0100_0001_0007 +1');
  assert.equal(c['alert-yellow'], '');
  assert.equal(overlayContent({ ...base, status: { ...clean, hms: [info] } })['alert-yellow'], '');
});

test('formatDuration and formatClock', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(26), '26m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(86), '1h 26m');
  assert.equal(formatDuration(1460), '24h 20m');
  assert.equal(formatClock(new Date('2026-10-19T04:58:00+08:00'), now, 'Australia/Perth'), '04:58');
  assert.equal(formatClock(new Date('2026-10-20T03:52:00+08:00'), now, 'Australia/Perth'), 'TUE 03:52');
  // Clock times follow the configured zone.
  assert.equal(formatClock(new Date('2026-10-19T04:58:00+08:00'), now, 'America/Los_Angeles'), '13:58');
});

// A printer reports about once a second for as long as it prints, and every
// report becomes overlay text. What that builds per report must not outlive
// it: a date formatter does, its memory lies outside the JavaScript heap and
// comes back only at a full garbage collection.
test('a long print does not grow the process: every way the overlay shows a clock time', () => {
  const REPORTS = 4000;
  const LIMIT_MB = 32;
  const hostZone: Omit<OverlayInput, 'status'> = { available: true, name: 'H2C', now, finishedAt: null };
  const cases: Array<[string, (i: number) => OverlayInput]> = [
    ['ETA today', (i) => ({ ...base, status: { ...clean, remainingMinutes: 1 + (i % 60) } })],
    ['ETA on another day', (i) => ({ ...base, status: { ...clean, remainingMinutes: 1440 + (i % 60) } })],
    ['finished, with the time it finished', (i) => ({ ...base, status: { ...clean, state: 'finished' }, finishedAt: new Date(now.getTime() - i * 1000) })],
    ["ETA in the host's time zone", (i) => ({ ...hostZone, status: { ...clean, remainingMinutes: 1 + (i % 60) } })],
  ];
  const grew: string[] = [];
  for (const [name, input] of cases) {
    overlayContent(input(0)); // what is built once is built here
    const before = process.memoryUsage.rss();
    for (let i = 0; i < REPORTS; i++) overlayContent(input(i));
    const grownMb = Math.round((process.memoryUsage.rss() - before) / 1024 / 1024);
    if (grownMb >= LIMIT_MB) grew.push(`${name}: ${grownMb} MB`);
  }
  assert.deepEqual(grew, [], `${REPORTS} reports each may grow the process by less than ${LIMIT_MB} MB`);
});

test('every layer file is unique, and the filter draws every layer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bamboozle-ovl-'));
  try {
    const files = new OverlayFiles(dir);
    const filter = overlayFilter(files, { bold: '/fonts/bold.otf', medium: '/fonts/medium.otf' });
    assert.equal((filter.match(/drawtext=/g) ?? []).length, LAYERS.length);
    assert.equal(new Set(LAYER_FILES).size, LAYER_FILES.length);
    for (const file of LAYER_FILES) assert.ok(filter.includes(`textfile=${files.path(file)}`), file);
    for (const piece of filter.split(',drawtext=').slice(1)) {
      assert.ok(piece.startsWith('expansion=none:reload=1:'), 'never expand, always reload');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OverlayFiles: every file exists up front, writes are private and only on change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bamboozle-ovl-'));
  try {
    const files = new OverlayFiles(dir);
    for (const file of LAYER_FILES) assert.equal(files.read(file), '');
    assert.equal(statSync(files.path('big')).mode & 0o777, 0o600);
    files.write(overlayContent({ ...base, status: printing }));
    assert.equal(files.read('big'), '47%');
    const before = statSync(files.path('name')).mtimeMs;
    files.write(overlayContent({ ...base, status: { ...printing, progress: 48 } }));
    assert.equal(files.read('big'), '48%');
    assert.equal(statSync(files.path('name')).mtimeMs, before, 'unchanged files are not rewritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paths that would break an ffmpeg filter are refused', () => {
  for (const bad of ["/tmp/it's", '/tmp/a:b', '/tmp/a,b', '/tmp/a;b', '/tmp/[x]', '/tmp/a=b', 'C:\\x']) {
    assert.throws(() => assertFilterSafePath(bad), /ffmpeg filters/, bad);
  }
  assert.doesNotThrow(() => assertFilterSafePath('/var/lib/bamboozle/storage/overlay/SERIAL1'));
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-filters'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

test('ffmpeg renders the overlay, and different states render differently', { skip: !hasFfmpeg && 'ffmpeg not available' }, async () => {
  const { resolveFonts } = await import('../src/camera/fonts.ts');
  const fonts = resolveFonts();
  const dir = mkdtempSync(join(tmpdir(), 'bamboozle-render-'));
  try {
    const render = (input: OverlayInput, name: string) => {
      const files = new OverlayFiles(join(dir, name));
      files.write(overlayContent(input));
      const out = join(dir, `${name}.png`);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=1680x1080',
        '-frames:v', '1', '-update', '1', '-filter_complex', overlayFilter(files, fonts), '-y', out]);
      return createHash('sha256').update(readFileSync(out)).digest('hex');
    };
    const a = render({ ...base, status: printing }, 'printing');
    const b = render({ ...base, status: null, available: false }, 'offline');
    const c = render({ ...base, status: printing }, 'printing-again');
    assert.notEqual(a, b);
    assert.equal(a, c, 'same state, same pixels');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The Home app draws the snapshot age ("now", "6s") over the bottom-left
// corner of a camera tile. Measured on a full-width iPhone tile and mapped to
// the 1280x720 canvas, it covers about x 34-123, y 642-678.
const HOME_LABEL_ZONE = { right: 135, top: 640 };

test('nothing left-aligned sits where the Home app puts its snapshot age', () => {
  const blocked = LAYERS.filter((layer) => {
    const x = Number(layer.x);
    const y = Number(layer.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false; // right-aligned or computed
    return x < HOME_LABEL_ZONE.right && y + layer.size > HOME_LABEL_ZONE.top;
  });
  assert.deepEqual(blocked.map((layer) => layer.file), []);
});

// Invented codes and texts: what Bambu writes for a code is theirs, and some
// of it is not public.
const texts: Record<string, string> = {
  'error:0C001234': 'The nozzle may be clogged, so the extrusion of filament was paused here. Check the hotend and resume when it is clear.',
  'hms:0C0003000002ABCD': 'The camera saw something odd on the plate.',
  'hms:0300010000010007': 'The heatbed is too hot.',
};
const explain: OverlayInput['explain'] = (kind, key) => texts[`${kind}:${key}`];

test('a known code gets its explanation under the alert, wrapped on whole words', () => {
  const c = overlayContent({ ...base, explain, status: { ...clean, state: 'paused', printError: 0x0c001234 } });
  assert.equal(c['alert-red'], 'ERROR 0C00_1234');
  const lines = c['explanation']!.split('\n');
  assert.ok(lines.length >= 2, 'a 120-character text needs more than one line');
  assert.ok(lines.every((line) => line.length <= EXPLANATION_COLUMNS && line === line.trim()), JSON.stringify(lines));
  assert.equal(lines.join(' '), texts['error:0C001234']);

  const hms = { code: '0C00_0300_0002_ABCD', severity: 'serious' as const, attr: 0, rawCode: 0 };
  const serious = overlayContent({ ...base, explain, status: { ...clean, hms: [hms] } });
  assert.equal(serious['alert-yellow'], 'HMS 0C00_0300_0002_ABCD');
  assert.equal(serious['explanation'], 'The camera saw something odd on the plate.');
});

test('the explanation follows the alert that is shown', () => {
  const fatal = { code: '0300_0100_0001_0007', severity: 'fatal' as const, attr: 0, rawCode: 0 };
  const serious = { code: '0C00_0300_0002_ABCD', severity: 'serious' as const, attr: 0, rawCode: 0 };
  const info = { code: '0C00_0300_0004_ABCD', severity: 'info' as const, attr: 0, rawCode: 0 };
  assert.equal(overlayContent({ ...base, explain, status: { ...clean, hms: [fatal, serious] } })['explanation'], 'The heatbed is too hot.');
  // A print error wins over HMS messages, its text too.
  const both = overlayContent({ ...base, explain, status: { ...clean, printError: 0x0c001234, hms: [serious] } });
  assert.match(both['explanation']!, /^The nozzle may be clogged/);
  // Messages the overlay does not show get no text either.
  assert.equal(overlayContent({ ...base, explain, status: { ...clean, hms: [info] } })['explanation'], '');
});

test('an unknown code, or no texts at all, shows the code alone', () => {
  const unknown = overlayContent({ ...base, explain, status: { ...clean, printError: 0x0c009999 } });
  assert.equal(unknown['alert-red'], 'ERROR 0C00_9999');
  assert.equal(unknown['explanation'], '');
  const none = overlayContent({ ...base, status: { ...clean, printError: 0x0c001234 } });
  assert.equal(none['alert-red'], 'ERROR 0C00_1234');
  assert.equal(none['explanation'], '');
  const offline = overlayContent({ ...base, explain, status: { ...clean, printError: 0x0c001234 }, available: false });
  assert.equal(offline['explanation'], '');
});

test('a text longer than the box ends in an ellipsis on its last line', () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const c = overlayContent({ ...base, explain: () => long, status: { ...clean, printError: 0x0c001234 } });
  const lines = c['explanation']!.split('\n');
  assert.equal(lines.length, EXPLANATION_LINES);
  assert.ok(lines.every((line) => line.length <= EXPLANATION_COLUMNS));
  assert.ok(lines.at(-1)!.endsWith('...'));
  // A word longer than a line is cut, not lost.
  const unbroken = 'x'.repeat(EXPLANATION_COLUMNS + 5);
  const cut = overlayContent({ ...base, explain: () => unbroken, status: { ...clean, printError: 0x0c001234 } });
  assert.equal(cut['explanation']!.replace(/\n/g, ''), unbroken);
});
