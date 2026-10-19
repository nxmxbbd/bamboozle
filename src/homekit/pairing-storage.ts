import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AccessoryInfo, HAPStorage } from 'hap-nodejs';

// HAP-NodeJS keeps the pairing state in storage/hap, one JSON file per key and
// bridge: AccessoryInfo.<id>.json (the bridge's long-term keys and the paired
// Home app controllers), IdentifierCache.<id>.json (the ids the Home app hangs
// rooms and automations on) and ControllerStorage.<id>.json (camera settings).
// Two of its habits cost a paired bridge when the disk fills up:
// - it rewrites AccessoryInfo on every start, with a plain write that empties
//   the file before it fails, and
// - a file it cannot parse reads as missing, so the next start quietly makes
//   new keys, and the Home app shows the bridge as not responding until it is
//   removed and added again.
// Both are closed here: writes cannot leave a file half done, unchanged files
// are not written at all, and a file that is there but unreadable stops the
// bridge instead of being replaced.

/** The files HAP-NodeJS 0.14 keeps per bridge, as <kind>.<id>.json. */
const PAIRING_FILE_KINDS = ['AccessoryInfo', 'IdentifierCache', 'ControllerStorage'] as const;

/** What node-persist 0.0.x (HAP-NodeJS's storage) looks like from the inside. */
interface NodePersist {
  options: { dir: string; ttl?: unknown; stringify: (value: unknown) => string };
  data: Record<string, unknown>;
  persistKeySync(key: string): void;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Where a write to `file` lands: the file a link points to (even one not created yet), else the file. */
function destination(file: string): string {
  try {
    return realpathSync(file);
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
  try {
    return resolve(dirname(file), readlinkSync(file)); // a link to a file that does not exist yet
  } catch (error) {
    if (code(error) === 'ENOENT' || code(error) === 'EINVAL') return file; // missing, or not a link
    throw error;
  }
}

/**
 * Write a file so that it is either the old or the new content, never a half
 * of either. A symbolic link is written through: its target is replaced (or
 * created) and the link stays.
 */
export function writeAtomically(file: string, text: string): void {
  const target = destination(file);
  // A dot name: node-persist skips dot files when it loads the directory.
  // Unique and created exclusively: another process saving to the same
  // storage cannot empty it before it is renamed into place. A crash between
  // write and rename leaves one such file behind; it is not swept up at start,
  // because that could delete another process's file mid-save.
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, target);
  } catch (error) {
    // EEXIST: the name was taken, so the file is someone else's to remove.
    if (code(error) !== 'EEXIST') rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Save one pairing file. HAP-NodeJS saves AccessoryInfo on every start, almost
 * always unchanged: skipping those writes lets the bridge start on a full disk.
 */
export function savePairingFile(file: string, text: string): void {
  try {
    if (readFileSync(file, 'utf8') === text) return;
  } catch {
    // missing or unreadable: write it
  }
  writeAtomically(file, text);
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

function unreadable(file: string, found: string, hapDir: string, keysFile: string): string {
  const name = basename(file);
  if (name === keysFile) {
    return (
      `${file} cannot be read (${found}). Not starting: HAP-NodeJS would quietly make a new pairing identity, ` +
      `and the Home app would show the bridge as not responding until it is removed and added again. ` +
      `Restore ${hapDir} from a backup and start again. To pair from scratch instead, remove the bridge ` +
      `from the Home app, then delete ${hapDir}.`
    );
  }
  const lost = name.startsWith('IdentifierCache.') ? ': the accessory ids the Home app keeps rooms and automations on' : '';
  return (
    `${file} cannot be read (${found}). Not starting: HAP-NodeJS would quietly start this file afresh. ` +
    `The pairing is not affected (its keys are in ${keysFile}), but what the file held would be lost${lost}. ` +
    `Restore the file from a backup and start again; without a backup, move it out of ${hapDir} and start again.`
  );
}

/**
 * Throws when one of this bridge's pairing files exists but cannot be read.
 * Missing files are fine: that is a bridge that has not been paired yet (or
 * was reset on purpose). Files of other bridges and anything else in the
 * directory are not looked at: HAP-NodeJS loads them, and nothing uses them.
 */
export function checkPairingFiles(hapDir: string, username: string): void {
  let names: string[];
  try {
    names = readdirSync(hapDir).sort();
  } catch (error) {
    if (code(error) === 'ENOENT') return;
    throw error;
  }
  const keysFile = AccessoryInfo.persistKey(username);
  const id = keysFile.slice(keysFile.indexOf('.')); // ".<id>.json"
  const ours = new Set(PAIRING_FILE_KINDS.map((kind) => `${kind}${id}`));
  for (const name of names) {
    if (!ours.has(name)) continue;
    const file = join(hapDir, name);
    const stats = statSync(file, { throwIfNoEntry: false }); // follows links
    let found: string | null;
    if (stats === undefined) found = 'a link to nothing';
    else if (!stats.isFile()) continue;
    else found = problem(readFileSync(file, 'utf8'), name === keysFile);
    if (found !== null) throw new Error(unreadable(file, found, hapDir, keysFile));
  }
}

/**
 * Make HAP-NodeJS save its pairing files with savePairingFile. Call after
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
    savePairingFile(join(this.options.dir, key), this.options.stringify(this.data[key]));
  };
}
