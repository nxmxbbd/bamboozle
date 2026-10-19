import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AccessoryInfo } from '@homebridge/hap-nodejs';

// HAP-NodeJS keeps the pairing state in storage/hap, one JSON file per key and
// bridge: AccessoryInfo.<id>.json (the bridge's long-term keys and the paired
// Home app controllers), IdentifierCache.<id>.json (the ids the Home app hangs
// rooms and automations on) and ControllerStorage.<id>.json (camera settings).
// Since 2.2 it saves them atomically, so a full disk no longer empties them.
// But a file it cannot parse still reads as missing: the next start quietly
// makes new keys (or ids), and the Home app shows the bridge as not
// responding until it is removed and added again. checkPairingFiles stops the
// bridge instead, while the damaged file can still be restored.

/** The files HAP-NodeJS keeps per bridge, as <kind>.<id>.json. */
const PAIRING_FILE_KINDS = ['AccessoryInfo', 'IdentifierCache', 'ControllerStorage'] as const;

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
  // A dot name: HAP-NodeJS skips dot files when it loads its directory.
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
