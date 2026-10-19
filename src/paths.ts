import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where the config lives when nothing says otherwise:
 * $XDG_CONFIG_HOME/bamboozle/config.json, or ~/.config/bamboozle/config.json.
 * The pairing keys live next to it (storagePath is relative to the config),
 * so one fixed place means one bridge identity, wherever you run bamboozle.
 */
export function defaultConfigPath(env: Env = process.env, home: () => string = homedir): string {
  // The XDG spec says to ignore a relative XDG_CONFIG_HOME.
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, 'bamboozle', 'config.json');
  const dir = home().trim();
  if (!dir) throw new Error('cannot find your home directory: pass --config <file> or set BAMBOOZLE_CONFIG');
  return join(dir, '.config', 'bamboozle', 'config.json');
}

/** --config, then BAMBOOZLE_CONFIG, then the default. */
export function resolveConfigPath(flag: string | undefined, env: Env = process.env, home: () => string = homedir): string {
  if (flag !== undefined) {
    if (flag.trim() === '') throw new Error('--config needs a file path');
    return flag;
  }
  const fromEnv = env['BAMBOOZLE_CONFIG']?.trim();
  if (fromEnv) return fromEnv;
  return defaultConfigPath(env, home);
}

/**
 * The first directory at or above `path` that other users could use to
 * swap what lies below it (config, access code, pairing keys), or null.
 * The nearest existing one is where things are still to be created, so any
 * write access for everyone counts there: the sticky bit only protects names
 * that already exist. Further up, a sticky directory such as /tmp is fine.
 * Windows reports every directory as writable, so it is not checked there.
 */
export function openToEveryone(path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  const lexical = resolve(path);
  const found = walkUp(lexical);
  if (found) return found;
  // A symlink on the way leads somewhere else: its target and everything
  // above that count as well. (The directories holding the links are
  // covered by the walk above.)
  let existing = lexical;
  while (!existsSync(existing)) {
    const up = dirname(existing);
    if (up === existing) return null;
    existing = up;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    return null;
  }
  return real === existing ? null : walkUp(real);
}

function walkUp(start: string): string | null {
  let current = start;
  let nearest = true;
  for (;;) {
    let mode: number | undefined;
    try {
      mode = statSync(current).mode;
    } catch {
      // not there (yet)
    }
    if (mode !== undefined) {
      if (mode & 0o002 && (nearest || !(mode & 0o1000))) return current;
      nearest = false;
    }
    const up = dirname(current);
    if (up === current) return null;
    current = up;
  }
}

/**
 * What to do about `open` (from openToEveryone) for `place`. chmod only for a
 * directory of one's own that is not sticky: run as root, "chmod 700 /tmp"
 * would succeed and break every other program. Below a sticky directory, a
 * private directory made first is safe (others cannot rename it away).
 */
export function openAdvice(open: string, place: string): string {
  let mode = 0;
  let owner: number | undefined;
  try {
    const stat = statSync(open);
    mode = stat.mode;
    owner = stat.uid;
  } catch {
    // gone meanwhile: fall through to the generic advice
  }
  if (owner !== undefined && owner === process.getuid?.() && !(mode & 0o1000)) return 'Run chmod 700 on it (or at least chmod o-w).';
  const below = relative(open, resolve(place)).split(sep)[0];
  if (mode & 0o1000 && below && below !== '..') {
    return `Create ${join(open, below)} yourself first (mkdir -m 700 ${join(open, below)}), or put the config somewhere private with --config.`;
  }
  return 'Put the config somewhere private with --config.';
}
