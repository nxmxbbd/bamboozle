import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
  let current = resolve(path);
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
