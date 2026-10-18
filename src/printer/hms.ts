export type HmsSeverity = 'fatal' | 'serious' | 'common' | 'info' | 'unknown';

export interface HmsEntry {
  /** `AAAA_BBBB_CCCC_DDDD`, the form used by the Bambu Lab wiki. */
  code: string;
  severity: HmsSeverity;
  attr: number;
  rawCode: number;
}

const SEVERITY: Record<number, HmsSeverity> = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

export function decodeHms(attr: number, rawCode: number): HmsEntry {
  const a = attr >>> 0;
  const c = rawCode >>> 0;
  const code = `${hex4(a >>> 16)}_${hex4(a & 0xffff)}_${hex4(c >>> 16)}_${hex4(c & 0xffff)}`;
  const severity = SEVERITY[c >>> 16] ?? 'unknown';
  return { code, severity, attr: a, rawCode: c };
}

/**
 * Wiki page for an HMS code. Only the H2 path is known to resolve for H2
 * codes (the X1 path 404s for them); other series fall back to the index.
 */
export function hmsWikiUrl(code: string, series: 'h2' | null): string {
  if (series === 'h2') return `https://wiki.bambulab.com/en/h2/troubleshooting/hmscode/${code}`;
  return 'https://wiki.bambulab.com/en/hms/home';
}
