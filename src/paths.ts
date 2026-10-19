import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
