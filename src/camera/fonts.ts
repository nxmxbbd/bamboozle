import { execFileSync } from 'node:child_process';
import type { OverlayFonts } from './overlay.ts';

function fcMatch(pattern: string): string {
  try {
    return execFileSync('fc-match', ['-f', '%{file}', pattern], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * The overlay is laid out for Hermit (monospace, advance 0.617 em). Paths
 * come from fontconfig unless configured; any other monospace font works but
 * shifts the detail columns slightly.
 */
export function resolveFonts(override: Partial<OverlayFonts> = {}, warn: (message: string) => void = () => {}): OverlayFonts {
  const pick = (weight: 'bold' | 'medium'): string => {
    const configured = override[weight];
    if (configured) return configured;
    const found = fcMatch(`Hermit:${weight}`);
    if (!found) throw new Error(`no font found for the overlay; install Hermit (e.g. fonts-hermit) or set camera.fonts.${weight}`);
    if (!/hermit/i.test(found)) warn(`Hermit not installed; overlay uses ${found} (install fonts-hermit for the intended layout)`);
    return found;
  };
  return { bold: pick('bold'), medium: pick('medium') };
}
