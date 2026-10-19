import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Accessory, Bridge, Characteristic, HAPStorage, Service, uuid } from '@homebridge/hap-nodejs';
import { VERSION } from '../version.ts';
import { ADVERTISER_CIAO, CATEGORY_BRIDGE, EVENT_PAIRED, EVENT_UNPAIRED } from './hap-constants.ts';
import { homeKitName } from './names.ts';
import { checkPairingFiles, writeAtomically } from './pairing-storage.ts';

export interface BridgeIdentity {
  /** HAP "username": a locally administered MAC address. */
  username: string;
  /** Setup code, XXX-XX-XXX. */
  pincode: string;
  setupID: string;
}

// Codes HomeKit refuses: repeated digits and the two obvious sequences.
const DISALLOWED_CODES = new Set([
  ...Array.from({ length: 10 }, (_, digit) => String(digit).repeat(8)),
  '12345678',
  '87654321',
]);

export function generatePincode(): string {
  for (;;) {
    const digits = Array.from({ length: 8 }, () => randomInt(10)).join('');
    if (!DISALLOWED_CODES.has(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  }
}

export function generateUsername(): string {
  const bytes = randomBytes(6);
  bytes[0] = ((bytes[0] as number) & 0xfc) | 0x02; // unicast, locally administered
  return [...bytes].map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

const SETUP_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function generateSetupId(): string {
  return Array.from({ length: 4 }, () => SETUP_ID_ALPHABET[randomInt(SETUP_ID_ALPHABET.length)]).join('');
}

const USERNAME = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const PINCODE = /^\d{3}-\d{2}-\d{3}$/;
const SETUP_ID = /^[0-9A-Z]{4}$/;

function isIdentity(value: unknown): value is BridgeIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['username'] === 'string' && USERNAME.test(v['username']) &&
    typeof v['pincode'] === 'string' && PINCODE.test(v['pincode']) &&
    !DISALLOWED_CODES.has(v['pincode'].replaceAll('-', '')) &&
    typeof v['setupID'] === 'string' && SETUP_ID.test(v['setupID'])
  );
}

/**
 * The bridge identity is created once and then reused: changing it makes the
 * Home app see a new, unpaired bridge.
 */
export function loadOrCreateIdentity(storagePath: string): BridgeIdentity {
  const file = join(storagePath, 'bridge.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isIdentity(parsed)) throw new Error(`${file} is not a valid bridge identity; fix or delete it`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Missing because it points somewhere that is not there (an unmounted volume)?
  // A new identity would be a new bridge to the Home app: stop instead.
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${file} is a link to nothing. Restore what it points to; or, to start over as a new bridge, remove the link (and the old bridge from the Home app).`);
  }
  const identity: BridgeIdentity = { username: generateUsername(), pincode: generatePincode(), setupID: generateSetupId() };
  mkdirSync(storagePath, { recursive: true, mode: 0o700 });
  writeAtomically(file, `${JSON.stringify(identity, null, 2)}\n`);
  chmodSync(file, 0o600);
  return identity;
}

export interface BridgeOptions {
  name: string;
  port: number;
  /** Interfaces or addresses to advertise on (hap-nodejs always listens on all); all when undefined. */
  bind?: string[];
  storagePath: string;
  log?: Pick<Console, 'log' | 'warn'>;
  /** A camera settings save that failed is tried again this often (default CAMERA_SETTINGS_RETRY_MS). */
  cameraSettingsRetryMs?: number;
}

/** How often a failed camera settings save (a full disk) is tried again. */
export const CAMERA_SETTINGS_RETRY_MS = 60_000;

export interface RunningBridge {
  identity: BridgeIdentity;
  setupURI: string;
  isPaired(): boolean;
  onPairingChange(listener: (paired: boolean) => void): void;
  stop(): Promise<void>;
}

export async function startBridge(options: BridgeOptions, accessories: Accessory[]): Promise<RunningBridge> {
  const hapStorage = join(options.storagePath, 'hap');
  mkdirSync(hapStorage, { recursive: true, mode: 0o700 });
  HAPStorage.setCustomStoragePath(hapStorage);

  const identity = loadOrCreateIdentity(options.storagePath);
  // Before HAP-NodeJS loads the files: it would read a broken one as missing.
  checkPairingFiles(hapStorage, identity.username);
  const bridge = new Bridge(homeKitName(options.name, 'bamboozle'), uuid.generate('bamboozle:bridge'));
  bridge
    .getService(Service.AccessoryInformation)!
    .setCharacteristic(Characteristic.Manufacturer, 'bamboozle')
    .setCharacteristic(Characteristic.Model, 'LAN bridge')
    .setCharacteristic(Characteristic.SerialNumber, identity.username)
    .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
  bridge.addBridgedAccessories(accessories);

  // HAP-NodeJS saves camera settings (whether each camera is on) from a timer,
  // where a failed save (a full disk) is an uncaught exception that ends the
  // process. The saved file is intact either way and every save writes the
  // whole state, so report it once and keep trying: a camera turned off while
  // the disk was full must not come back on at the next restart. Bridged
  // accessories save through this one.
  const storage = bridge.controllerStorage;
  const save = storage.save.bind(storage);
  const retryMs = options.cameraSettingsRetryMs ?? CAMERA_SETTINGS_RETRY_MS;
  let retry: NodeJS.Timeout | undefined;
  let failing = false;
  storage.save = () => {
    clearTimeout(retry);
    retry = undefined;
    try {
      save();
    } catch (error) {
      if (!failing) options.log?.warn(`camera settings not saved: ${(error as Error).message}; trying again every ${retryMs / 1000} s`);
      failing = true;
      retry = setTimeout(() => storage.save(), retryMs).unref();
      return;
    }
    if (!failing) return;
    failing = false;
    options.log?.log('camera settings saved again');
  };

  let paired = false;
  const listeners: Array<(paired: boolean) => void> = [];
  const setPaired = (value: boolean) => {
    if (value === paired) return;
    paired = value;
    for (const listener of listeners) listener(value);
  };
  bridge.on(EVENT_PAIRED, () => setPaired(true));
  bridge.on(EVENT_UNPAIRED, () => setPaired(false));

  await bridge.publish({
    username: identity.username,
    pincode: identity.pincode,
    setupID: identity.setupID,
    port: options.port,
    category: CATEGORY_BRIDGE,
    advertiser: ADVERTISER_CIAO,
    ...(options.bind ? { bind: options.bind } : {}),
  });

  // HAP-NodeJS has no public "is paired" getter; read the loaded pairing table.
  const info = (bridge as unknown as { _accessoryInfo?: { pairedClients?: Record<string, unknown> } })._accessoryInfo;
  paired = Object.keys(info?.pairedClients ?? {}).length > 0;

  return {
    identity,
    setupURI: bridge.setupURI(),
    isPaired: () => paired,
    onPairingChange: (listener) => listeners.push(listener),
    stop: async () => {
      if (retry) storage.save(); // a last try for settings still unsaved
      clearTimeout(retry);
      await bridge.unpublish();
    },
  };
}
