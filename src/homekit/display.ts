import type { PrinterStatus } from '../printer/status.ts';

export const PROGRESS_STYLES = ['humidity', 'window', 'fan', 'lightbulb'] as const;
export type ProgressStyle = (typeof PROGRESS_STYLES)[number];

// Time left as a light sensor (lux = minutes). Sensors only appear in the
// Home app's status bar, not as tiles, so this is off by default: the camera
// overlay shows time left, and the sensor remains useful for automations.
export const COUNTDOWN_STYLES = ['lux'] as const;
export type CountdownStyle = (typeof COUNTDOWN_STYLES)[number];

export const TEMPERATURE_SENSORS = ['chamber', 'nozzle', 'bed'] as const;
export type TemperatureSensor = (typeof TEMPERATURE_SENSORS)[number];

/** What the HomeKit side shows, independent of how it is shown. */
export interface DisplayValues {
  /** False until a full status arrived, and while the printer is unreachable. */
  available: boolean;
  printing: boolean;
  /** 0-100, integer. */
  progress: number;
  /** Minutes left; 0 when not printing. */
  remainingMinutes: number;
  fault: boolean;
  temperatures: Record<TemperatureSensor, number | null>;
}

// HomeKit's light level has a floor of 0.0001 lux.
export const MIN_LUX = 0.0001;

export function remainingToLux(minutes: number): number {
  return Math.max(minutes, MIN_LUX);
}

const ACTIVE_STATES = new Set(['preparing', 'printing', 'paused']);

export function toDisplay(status: PrinterStatus | null, available: boolean): DisplayValues {
  const printing = status !== null && ACTIVE_STATES.has(status.state);
  const progress = Math.min(100, Math.max(0, Math.round(status?.progress ?? 0)));
  return {
    available: available && status !== null,
    printing,
    progress,
    remainingMinutes: printing ? Math.max(0, Math.round(status?.remainingMinutes ?? 0)) : 0,
    fault: status !== null && (status.printError !== 0 || status.hms.some((entry) => entry.severity === 'fatal')),
    temperatures: {
      chamber: status?.chamber?.current ?? null,
      nozzle: status?.nozzle?.current ?? null,
      bed: status?.bed?.current ?? null,
    },
  };
}
