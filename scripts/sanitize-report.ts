// Scrub a raw printer report so it can be committed as a test fixture.
//
//   node scripts/sanitize-report.ts <raw.json> <fixture.json>
//
// Removes serial numbers, job / project names and ids, network addresses and
// filament RFID identifiers, then refuses to write if anything that still
// looks like a serial number or a non-documentation IPv4 address survived.

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
};

// Dotted quads without leading zeros. Firmware versions such as 01.02.00.00
// have zero-padded groups and are left alone.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
export const IPV4 = new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?![\\d.])`, 'g');

function scrub(value: Json, key: string | null): Json {
  if (key !== null && Object.hasOwn(REPLACE, key)) {
    const replacement = REPLACE[key] as Json;
    // Keep the original type so parsers see a realistic shape.
    if (typeof value === 'number' && typeof replacement === 'string') return 0;
    return replacement;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, null));
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
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
