// Apple's naming rule for HomeKit, which the Home app enforces when a name is
// saved: letters, digits, spaces and apostrophes only, starting and ending
// with a letter or digit. hap-nodejs does not check it, so names built here
// (or taken from the config) are sanitized before they reach HomeKit.
// Combining marks are allowed so scripts such as Devanagari or Thai survive.

const WORD = '\\p{L}\\p{N}';
const VALID = new RegExp(`^[${WORD}](?:[${WORD}\\p{M}' ]*[${WORD}\\p{M}])?$`, 'u');
const DISALLOWED = new RegExp(`[^${WORD}\\p{M}' ]+`, 'gu');
const EDGES = new RegExp(`^[^${WORD}]+|[^${WORD}\\p{M}]+$`, 'gu');

export function isValidHomeKitName(name: string): boolean {
  return VALID.test(name);
}

/** Turn any string into a name the Home app accepts. */
export function homeKitName(raw: string, fallback = 'Printer'): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(/[‘’ʼ]/g, "'") // curly apostrophes become straight ones
    .replace(DISALLOWED, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(EDGES, '');
  return cleaned === '' ? fallback : cleaned;
}
