import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BAR_SLOTS,
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
