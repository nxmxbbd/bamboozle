import { execFileSync } from 'node:child_process';

/** False without a working ffmpeg: the tests that need it are skipped then. */
export const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
