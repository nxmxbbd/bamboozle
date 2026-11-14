// What an independent HAP controller (hap-controller) reads from a bridge.

export interface HapCharacteristic {
  iid: number;
  type: string;
  value?: unknown;
  perms: string[];
}
export interface HapService {
  iid: number;
  type: string;
  primary?: boolean;
  characteristics: HapCharacteristic[];
}
export interface HapAccessory {
  aid: number;
  services: HapService[];
}

const HAP_BASE = '-0000-1000-8000-0026BB765291';
/** HAP-NodeJS reports Apple types in short form ("10"); expand for comparison. */
export function fullType(type: string): string {
  return /^[0-9A-F]{1,8}$/i.test(type) ? `${type.toUpperCase().padStart(8, '0')}${HAP_BASE}` : type.toUpperCase();
}
