import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

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
 * The first directory that other users could use to swap what bamboozle
 * reaches through `path` (config, access code, pairing keys), or null.
 * The path is resolved the way the kernel does it, one name at a time,
 * following every symlink (relative targets and chains included), and each
 * directory a name is looked up in counts: the one holding a link as much as
 * the link's target. There, a directory anyone may write to is fine only
 * with the sticky bit (/tmp), which stops others replacing names that exist.
 * The deepest existing directory is where things are still to be created,
 * and the sticky bit does not stop others creating a name first: any write
 * access for everyone counts there. Windows reports every directory as
 * writable, so it is not checked there.
 */
export function openToEveryone(path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  const lookedIn: string[] = []; // directories a name was looked up in, in order
  let current = parse(resolve(path)).root;
  let pending = resolve(path).split(sep).filter(Boolean);
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === '.') continue;
    if (name === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    lookedIn.push(current);
    let stat;
    try {
      stat = lstatSync(next);
    } catch {
      break; // not there (yet): it gets created in `current`
    }
    if (stat.isSymbolicLink()) {
      if (++links > 40) break; // a loop: the actual read fails later, with its own error
      const target = readlinkSync(next);
      pending = [...target.split(sep).filter(Boolean), ...pending];
      if (isAbsolute(target)) current = parse(target).root;
      continue;
    }
    if (!stat.isDirectory()) break; // a file in the way: reported by whatever reads the path
    current = next;
  }
  const mode = (dir: string) => {
    try {
      return statSync(dir).mode;
    } catch {
      return 0;
    }
  };
  if (mode(current) & 0o002) return current;
  for (const dir of new Set(lookedIn)) {
    const bits = mode(dir);
    if (bits & 0o002 && !(bits & 0o1000)) return dir;
  }
  return null;
}

/** A path as a shell word, for hints people copy. */
export function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * What to do about an open directory, from the facts about it. chmod is
 * right for one's own directory, except for root on a sticky one: that is
 * /tmp, and "chmod 700 /tmp" would break every other program. Below a
 * sticky directory, a private directory made first is safe (others cannot
 * rename it away); otherwise the config belongs somewhere else.
 */
export function adviceFor(facts: { mine: boolean; root: boolean; sticky: boolean; create?: string }): string {
  if (facts.mine && !(facts.sticky && facts.root)) return 'Run chmod 700 on it (or at least chmod o-w).';
  if (facts.sticky && facts.create) {
    return `Create ${facts.create} yourself first (mkdir -m 700 ${shellWord(facts.create)}), or put the config somewhere private with --config.`;
  }
  return 'Put the config somewhere private with --config.';
}

/** adviceFor() for `open` (from openToEveryone), reached on the way to `place`. */
export function openAdvice(open: string, place: string): string {
  let mode = 0;
  let owner: number | undefined;
  try {
    const stat = statSync(open);
    mode = stat.mode;
    owner = stat.uid;
  } catch {
    // gone meanwhile: the generic advice
  }
  const me = process.getuid?.();
  const below = relative(open, resolve(place)).split(sep)[0];
  return adviceFor({
    mine: owner !== undefined && owner === me,
    root: me === 0,
    sticky: (mode & 0o1000) !== 0,
    ...(below && below !== '..' ? { create: join(open, below) } : {}),
  });
}
