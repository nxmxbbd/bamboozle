import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AccessoryInfo, HAPStorage } from 'hap-nodejs';

// HAP-NodeJS keeps the pairing state in storage/hap, one JSON file per key:
// AccessoryInfo (the bridge's long-term keys and the paired Home app
// controllers), IdentifierCache (the ids the Home app hangs rooms and
// automations on) and ControllerStorage. Two of its habits cost a paired
// bridge when the disk fills up:
// - it rewrites AccessoryInfo on every start, with a plain write that empties
//   the file before it fails, and
// - a file it cannot parse reads as missing, so the next start quietly makes
//   new keys, and the Home app shows the bridge as not responding until it is
//   removed and added again.
// Both are closed here: writes cannot leave a file half done, and a file that
// is there but unreadable stops the bridge instead of being replaced.

/** What node-persist 0.0.x (HAP-NodeJS's storage) looks like from the inside. */
interface NodePersist {
  options: { dir: string; ttl?: unknown; stringify: (value: unknown) => string };
  data: Record<string, unknown>;
  persistKeySync(key: string): void;
}

/** Write a file so that it is either the old or the new content, never a half of either. */
export function writeAtomically(file: string, text: string): void {
  // A dot name: node-persist skips dot files when it loads the directory.
  // Unique and created exclusively: another process saving to the same
  // storage cannot empty it before it is renamed into place. A crash between
  // write and rename leaves one such file behind; it is not swept up at start,
  // because that could delete another process's file mid-save.
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function problem(text: string, keys: boolean): string | null {
  if (text.trim() === '') return 'empty';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not a JSON object';
  if (keys) {
    for (const key of ['signSk', 'signPk']) {
      const hex = (value as Record<string, unknown>)[key];
      if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex)) return `no ${key}`;
    }
  }
  return null;
}

/**
 * Throws when a pairing file exists but cannot be read. Missing files are
 * fine: that is a bridge that has not been paired yet (or was reset on purpose).
 */
export function checkPairingFiles(hapDir: string, username: string): void {
  let names: string[];
  try {
    names = readdirSync(hapDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const keysFile = AccessoryInfo.persistKey(username);
  for (const name of names) {
    const file = join(hapDir, name);
    const found = problem(readFileSync(file, 'utf8'), name === keysFile);
    if (found === null) continue;
    throw new Error(
      `${file} cannot be read (${found}). Not starting: HAP-NodeJS would quietly make a new pairing identity, ` +
        `and the Home app would show the bridge as not responding until it is removed and added again. ` +
        `Restore ${hapDir} from a backup and start again. To pair from scratch instead, remove the bridge ` +
        `from the Home app, then delete ${hapDir}.`,
    );
  }
}

/**
 * Make HAP-NodeJS save its pairing files with writeAtomically. Call after
 * HAPStorage.setCustomStoragePath and before publish(). HAP-NodeJS only uses
 * node-persist's synchronous calls (setItemSync, removeItemSync, getItem), and
 * setItemSync saves through persistKeySync, which this replaces.
 */
export function saveAtomically(): void {
  const store = HAPStorage.storage() as unknown as Partial<NodePersist>;
  const options = store.options;
  if (
    typeof store.persistKeySync !== 'function' ||
    typeof store.data !== 'object' ||
    typeof options?.dir !== 'string' ||
    typeof options.stringify !== 'function' ||
    options.ttl
  ) {
    throw new Error('the HAP-NodeJS storage is not the node-persist 0.0.x that bamboozle knows how to save safely');
  }
  store.persistKeySync = function persistKeySync(this: NodePersist, key: string): void {
    writeAtomically(join(this.options.dir, key), this.options.stringify(this.data[key]));
  };
}
