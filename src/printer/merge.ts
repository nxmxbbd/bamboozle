export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Array entries that carry one of these keys are merged entry-by-entry, so a
// delta that only mentions extruder 0 does not wipe extruder 1.
const ENTRY_KEYS = ['id', 'node'] as const;

function entryKey(items: Json[]): (typeof ENTRY_KEYS)[number] | null {
  if (items.length === 0) return null;
  for (const key of ENTRY_KEYS) {
    if (items.every((item) => isObject(item) && (typeof item[key] === 'string' || typeof item[key] === 'number'))) {
      return key;
    }
  }
  return null;
}

function mergeArrays(previous: Json[], next: Json[]): Json[] {
  const key = entryKey(next);
  if (key === null || entryKey(previous) !== key) return next;

  const merged = [...previous];
  for (const item of next) {
    const incoming = item as JsonObject;
    const index = merged.findIndex((existing) => (existing as JsonObject)[key] === incoming[key]);
    if (index === -1) {
      merged.push(incoming);
    } else {
      merged[index] = mergeReport(merged[index] as JsonObject, incoming);
    }
  }
  return merged;
}

/**
 * Accumulate an incremental `print` report into the state seen so far.
 *
 * Printers send the full status only when asked (`pushall`) and small deltas
 * otherwise. Objects merge recursively, keyed arrays merge per entry, and
 * everything else (scalars, unkeyed arrays such as `hms`) is replaced.
 *
 * Known limit: an entry removed from a keyed array (an AMS unit unplugged)
 * stays until the next full status, because a delta cannot express removal.
 */
export function mergeReport(previous: JsonObject, delta: JsonObject): JsonObject {
  const merged: JsonObject = { ...previous };
  for (const [key, value] of Object.entries(delta)) {
    const existing = merged[key];
    if (isObject(existing) && isObject(value)) {
      merged[key] = mergeReport(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = mergeArrays(existing, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
