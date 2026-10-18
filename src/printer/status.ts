import { decodeHms, type HmsEntry } from './hms.ts';
import { isObject, type Json, type JsonObject } from './merge.ts';

export type PrintState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'failed' | 'unknown';

export interface Temperature {
  current: number;
  /** 0 when the heater is off. */
  target: number;
}

export interface NozzleTemperature extends Temperature {
  id: number;
}

export interface PrinterStatus {
  state: PrintState;
  /** Raw `gcode_state` (RUNNING, PAUSE, FINISH, ...). */
  gcodeState: string | null;
  /** Print progress, 0-100. */
  progress: number | null;
  /** Firmware countdown in minutes (wall clock, not the slicer estimate). */
  remainingMinutes: number | null;
  layer: number | null;
  totalLayers: number | null;
  /** Every extruder the printer reports, by id (two on H2D / H2C). */
  nozzles: NozzleTemperature[];
  activeNozzleId: number | null;
  /** The active extruder. */
  nozzle: Temperature | null;
  bed: Temperature | null;
  chamber: Temperature | null;
  chamberLight: boolean | null;
  hms: HmsEntry[];
  printError: number;
  /**
   * True when the firmware only accepts signed control commands (Developer
   * Mode off); controls must be hidden then. Null until `fun` is reported.
   */
  signatureRequired: boolean | null;
}

const GCODE_STATES: Record<string, PrintState> = {
  IDLE: 'idle',
  INIT: 'preparing',
  SLICING: 'preparing',
  PREPARE: 'preparing',
  RUNNING: 'printing',
  PAUSE: 'paused',
  FINISH: 'finished',
  FAILED: 'failed',
};

// Bit in the `fun` capability mask, set while MQTT command signing is enforced.
const SIGNATURE_REQUIRED_BIT = 0x20000000n;

function num(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: Json | undefined): JsonObject | null {
  return isObject(value) ? value : null;
}

function at(root: JsonObject, ...path: string[]): Json | undefined {
  let node: Json | undefined = root;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** H2-style packed temperature: `(target << 16) | current`. */
export function unpackTemperature(packed: number): Temperature {
  const value = packed >>> 0;
  return { current: value & 0xffff, target: value >>> 16 };
}

function flatTemperature(print: JsonObject, currentKey: string, targetKey: string): Temperature | null {
  const current = num(print[currentKey]);
  if (current === null) return null;
  return { current, target: num(print[targetKey]) ?? 0 };
}

function packedTemperature(print: JsonObject, ...path: string[]): Temperature | null {
  const packed = num(at(print, ...path));
  return packed === null ? null : unpackTemperature(packed);
}

function parseNozzles(print: JsonObject): NozzleTemperature[] {
  const info = at(print, 'device', 'extruder', 'info');
  if (!Array.isArray(info)) return [];
  const nozzles: NozzleTemperature[] = [];
  for (const entry of info) {
    const e = obj(entry);
    const id = e && num(e['id']);
    const packed = e && num(e['temp']);
    if (id === null || id === undefined || packed === null || packed === undefined) continue;
    nozzles.push({ id, ...unpackTemperature(packed) });
  }
  return nozzles.sort((a, b) => a.id - b.id);
}

function parseChamberLight(print: JsonObject): boolean | null {
  const lights = print['lights_report'];
  if (!Array.isArray(lights)) return null;
  const chamber = lights.map(obj).find((light) => light?.['node'] === 'chamber_light');
  const mode = chamber?.['mode'];
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return null;
}

function parseHms(print: JsonObject): HmsEntry[] {
  const list = print['hms'];
  if (!Array.isArray(list)) return [];
  const entries: HmsEntry[] = [];
  for (const item of list) {
    const entry = obj(item);
    const attr = entry && num(entry['attr']);
    const code = entry && num(entry['code']);
    if (attr === null || attr === undefined || code === null || code === undefined) continue;
    entries.push(decodeHms(attr, code));
  }
  return entries;
}

function parseSignatureRequired(print: JsonObject): boolean | null {
  const fun = print['fun'];
  if (typeof fun !== 'string' || !/^[0-9a-fA-F]{1,16}$/.test(fun)) return null;
  return (BigInt(`0x${fun}`) & SIGNATURE_REQUIRED_BIT) !== 0n;
}

/**
 * Normalise an accumulated report (the `print` object, or a message that
 * wraps it) into a model-independent status.
 */
export function parseStatus(report: JsonObject): PrinterStatus {
  const print = obj(report['print']) ?? report;

  const gcodeState = typeof print['gcode_state'] === 'string' ? print['gcode_state'] : null;
  const nozzles = parseNozzles(print);

  // H2 series: the active extruder index sits in bits 4-7 of extruder.state.
  const extruderState = num(at(print, 'device', 'extruder', 'state'));
  const activeNozzleId = nozzles.length > 0 && extruderState !== null ? (extruderState >>> 4) & 0xf : null;
  const activeNozzle = nozzles.find((n) => n.id === activeNozzleId);

  const nozzle: Temperature | null = activeNozzle
    ? { current: activeNozzle.current, target: activeNozzle.target }
    : flatTemperature(print, 'nozzle_temper', 'nozzle_target_temper');

  return {
    // Own properties only: "constructor" or "__proto__" must not resolve.
    state: gcodeState !== null && Object.hasOwn(GCODE_STATES, gcodeState) ? (GCODE_STATES[gcodeState] as PrintState) : 'unknown',
    gcodeState,
    progress: num(print['mc_percent']),
    remainingMinutes: num(print['mc_remaining_time']),
    layer: num(print['layer_num']),
    totalLayers: num(print['total_layer_num']),
    nozzles,
    activeNozzleId: activeNozzle ? activeNozzle.id : null,
    nozzle,
    bed: packedTemperature(print, 'device', 'bed', 'info', 'temp') ?? flatTemperature(print, 'bed_temper', 'bed_target_temper'),
    chamber: packedTemperature(print, 'device', 'ctc', 'info', 'temp') ?? flatTemperature(print, 'chamber_temper', 'chamber_target_temper'),
    chamberLight: parseChamberLight(print),
    hms: parseHms(print),
    printError: num(print['print_error']) ?? 0,
    signatureRequired: parseSignatureRequired(print),
  };
}
