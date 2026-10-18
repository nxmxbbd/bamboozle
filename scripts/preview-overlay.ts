// Render the camera overlay for every printer state into one contact sheet.
//
//   node scripts/preview-overlay.ts [--source <url or image>] [--out <dir>]
//
// Uses the real overlay code. Without --source a test pattern stands in for
// the camera. Needs ffmpeg with drawtext.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveFonts } from '../src/camera/fonts.ts';
import { OverlayFiles, overlayContent, overlayFilter, type OverlayInput } from '../src/camera/overlay.ts';
import { parseStatus, type PrinterStatus } from '../src/printer/status.ts';
import type { JsonObject } from '../src/printer/merge.ts';

const { values } = parseArgs({
  options: { source: { type: 'string' }, out: { type: 'string', default: 'preview' } },
});
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

const printing = parseStatus(
  JSON.parse(readFileSync(new URL('../test/fixtures/h2c-printing.json', import.meta.url), 'utf8')) as JsonObject,
);
const now = new Date('2026-10-19T03:32:00+08:00');
const base: Omit<OverlayInput, 'status'> = { available: true, name: 'H2C', now, finishedAt: null, timeZone: 'Australia/Perth' };
const idleTemps = { nozzle: { current: 32, target: 0 }, bed: { current: 27, target: 0 }, chamber: { current: 28, target: 0 } };
const clean: PrinterStatus = { ...printing, hms: [] };

const states: Array<[string, OverlayInput]> = [
  ['printing', { ...base, status: printing }],
  ['preparing', { ...base, status: { ...clean, state: 'preparing', progress: 0, remainingMinutes: 222, layer: 0 } }],
  ['paused', { ...base, status: { ...clean, state: 'paused' } }],
  ['finished', { ...base, status: { ...clean, ...idleTemps, state: 'finished', progress: 100, remainingMinutes: 0, layer: 120 }, finishedAt: new Date('2026-10-19T02:58:00+08:00') }],
  ['failed', { ...base, status: { ...clean, state: 'failed', printError: 0x03008008 } }],
  ['idle', { ...base, status: { ...clean, ...idleTemps, state: 'idle', progress: 0, remainingMinutes: 0 } }],
  ['long-print', { ...base, status: { ...clean, progress: 3, remainingMinutes: 1460, layer: 4, totalLayers: 1310 } }],
  ['offline', { ...base, status: null, available: false }],
];

// One still frame, so every state is drawn on the same picture.
const work = mkdtempSync(join(tmpdir(), 'bamboozle-preview-'));
const still = join(work, 'still.png');
const input = values.source
  ? [...(values.source.startsWith('rtsp') ? ['-rtsp_transport', 'tcp', '-skip_frame', 'nokey'] : []), '-i', values.source]
  : ['-f', 'lavfi', '-i', 'testsrc2=size=1680x1080:rate=1'];
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-frames:v', '1', '-update', '1', '-y', still]);

const fonts = resolveFonts({}, (message) => console.warn(message));
const rendered: string[] = [];
for (const [name, state] of states) {
  const files = new OverlayFiles(join(work, name));
  files.write(overlayContent(state));
  const target = join(out, `${name}.png`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', still, '-frames:v', '1', '-update', '1',
    '-filter_complex', overlayFilter(files, fonts), '-y', target]);
  rendered.push(target);
  console.log(`wrote ${target}`);
}

// Contact sheet: 2 columns, half size.
const sheet = join(out, 'sheet.png');
const inputs = rendered.flatMap((file) => ['-i', file]);
const scaled = rendered.map((_, i) => `[${i}:v]scale=640:360[s${i}]`).join(';');
const layout = rendered.map((_, i) => `${(i % 2) * 640}_${Math.floor(i / 2) * 360}`).join('|');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex',
  `${scaled};${rendered.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${rendered.length}:layout=${layout}`,
  '-frames:v', '1', '-update', '1', '-y', sheet]);
console.log(`wrote ${sheet}`);
rmSync(work, { recursive: true, force: true });
