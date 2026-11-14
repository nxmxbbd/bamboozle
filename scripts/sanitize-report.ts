// Scrub a raw printer report so it can be committed as a test fixture.
//
//   node scripts/sanitize-report.ts <raw.json> <fixture.json>
//
// Removes serial numbers, job / project names and ids, the file names,
// storage paths and links printers are known to report, network addresses and
// filament RFID identifiers, then refuses to write if anything that still
// looks like a serial number, a non-documentation IPv4 address, a link other
// than the camera's, a path or a file name survived.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isObject, type Json, type JsonObject } from '../src/printer/merge.ts';

const DOC_IP = '192.0.2.10'; // RFC 5737 documentation range

// Keys whose values identify the owner, the device or a job.
const REPLACE: Record<string, Json> = {
  sn: 'REDACTED',
  subtask_name: 'fixture',
  task_id: '0',
  subtask_id: '0',
  job_id: '0',
  lan_task_id: '0',
  project_id: '0',
  profile_id: '0',
  model_id: '',
  design_id: '',
  dev_id: 'REDACTED',
  ssid: 'REDACTED',
  mac: '00:00:00:00:00:00',
  tray_uuid: '00000000000000000000000000000000',
  tag_uid: '0000000000000000',
  ip: 0,
  mask: 0,
  gateway: 0,
  idx2: 0, // upgrade_state.idx2: meaning unknown, differs between reports, unused
  cert_id: 'REDACTED', // header of a signed command: the signing certificate
  sign_string: '', // and its signature
};

// Keys whose text can name a file of the owner, where it is stored or a link
// to it: the job's file (some printers report its name in gcode_file / file;
// the printer's reply to a print command, which shares the report topic,
// carries it in url / param), a time-lapse video, an error picture's id, an
// upload.
const PATHS = new Set(['gcode_file', 'file', 'url', 'param', 'timelapse_path', 'img_id', 'oss_url']);

// The G-code of a plate inside every project file. It names nothing of the
// owner, so it stays: it is what most printers report while printing.
const PLATE = /^\/?(?:data\/)?Metadata\/plate_\d+\.gcode$/i;

// Extensions of model, G-code, picture and video files.
const FILE_NAME = /\.(?:3mf|amf|obj|stl|step|stp|gcode|bmp|jpe?g|png|avi|mov|mp4)\b/i;
// What URL parsers still read as a link once they drop the tabs and line
// breaks inside it (stripped before the test): a scheme and a slash or
// backslash, or a web / file scheme followed by anything at all.
const LINK = /[a-z][a-z0-9+.-]*:[/\\]|\b(?:https?|ftp|wss?|file):(?=\S)/i;
// The camera link is the only link a report needs. scrub has already pointed
// every address at the documentation one, so that address alone grants nothing:
// the whole value must be the camera link.
const CAMERA_LINK = new RegExp(`^rtsps?://${DOC_IP.replaceAll('.', '\\.')}(?::\\d+)?(?:/streaming/live/\\d+)?/?$`, 'i');
// An absolute path anywhere in a value, slashes or backslashes (network
// shares too): one that does not continue a word or a number (0KB/s, and/or,
// 50/100, +/-5 stay), or a value that starts with one.
const PATH = /(?<![\p{L}\p{M}\p{N}_.+/\\-])[/\\]+[^\s/\\]|^\s*[/\\]/u;

// Dotted quads without leading zeros. Firmware versions such as 01.02.00.00
// have zero-padded groups and are left alone, and so is anything longer
// (1.2.3.4.5); a full stop after the address (end of a sentence) is fine.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
export const IPV4 = new RegExp(`(?<!\\d|\\d\\.)${OCTET}(?:\\.${OCTET}){3}(?!\\d|\\.\\d)`, 'g');

function scrub(value: Json, key: string | null, inPath = false): Json {
  if (key !== null && Object.hasOwn(REPLACE, key)) {
    const replacement = REPLACE[key] as Json;
    // Keep the original type so parsers see a realistic shape.
    if (typeof value === 'number' && typeof replacement === 'string') return 0;
    return replacement;
  }
  // Every string under these keys, also inside a list or an object there.
  const path = inPath || (key !== null && PATHS.has(key));
  if (path && typeof value === 'string') return PLATE.test(value) ? value : '';
  if (Array.isArray(value)) return value.map((item) => scrub(item, null, path));
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k, path);
    return out;
  }
  if (typeof value === 'string') return value.replace(IPV4, DOC_IP);
  return value;
}

/** Strings that must not appear in a committed fixture. */
export function findLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const match of text.matchAll(IPV4)) {
    if (match[0] !== DOC_IP && match[0] !== '0.0.0.0') leaks.push(`ipv4 ${match[0]}`);
  }
  // Bambu printer serials: 15 upper-case alphanumerics with at least one digit
  // and one letter, e.g. 01P00A000000000. Hex masks such as `fun` are 16 long.
  for (const match of text.matchAll(/"([0-9A-Z]{15})"/g)) {
    const candidate = match[1] as string;
    if (/[0-9]/.test(candidate) && /[A-Z]/.test(candidate)) leaks.push(`serial-like ${candidate}`);
  }
  // Links, paths and file names under any key, including keys this script
  // does not know yet.
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const value = JSON.parse(match[0]) as string;
    if (PLATE.test(value) || CAMERA_LINK.test(value)) continue;
    const controls = /[\u0000-\u001f]/g;
    if (LINK.test(value.replace(controls, '')) || LINK.test(value.replace(controls, ' '))) leaks.push(`link ${value}`);
    else if (PATH.test(value)) leaks.push(`path ${value}`);
    else if (FILE_NAME.test(value)) leaks.push(`file name ${value}`);
  }
  return leaks;
}

export function sanitize(raw: JsonObject): JsonObject {
  return scrub(raw, null) as JsonObject;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node scripts/sanitize-report.ts <raw.json> <fixture.json>');
    process.exit(2);
  }
  const cleaned = sanitize(JSON.parse(readFileSync(input, 'utf8')) as JsonObject);
  const text = `${JSON.stringify(cleaned, null, 2)}\n`;
  const leaks = findLeaks(text);
  if (leaks.length > 0) {
    console.error(`refusing to write ${output}; still contains:\n  ${leaks.join('\n  ')}`);
    process.exit(1);
  }
  writeFileSync(output, text);
  console.log(`wrote ${output}`);
}
