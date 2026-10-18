import { isObject, mergeReport, type JsonObject } from './merge.ts';
import { parseStatus, type PrinterStatus } from './status.ts';

/**
 * A pushall reply carries the whole state; deltas carry what changed. One
 * message counts as full only if it alone has everything the status needs:
 * state, progress, remaining time, error code and a nozzle temperature
 * (the flat nozzle_temper, or the per-extruder list of the H2 series).
 * A field count is no evidence: a large delta can still miss these.
 */
function isFullReport(print: JsonObject): boolean {
  const device = print['device'];
  const extruder = isObject(device) ? device['extruder'] : undefined;
  const temperature = typeof print['nozzle_temper'] === 'number' || (isObject(extruder) && Array.isArray(extruder['info']));
  return (
    typeof print['gcode_state'] === 'string' &&
    typeof print['mc_percent'] === 'number' &&
    typeof print['mc_remaining_time'] === 'number' &&
    typeof print['print_error'] === 'number' &&
    temperature
  );
}

/**
 * Turns raw MQTT report payloads into successive statuses. Only
 * `push_status` messages are merged; command replies that share the topic
 * (get_version, calibration results, ...) are ignored.
 */
export class ReportAccumulator {
  #print: JsonObject = {};
  #complete = false;

  /** True once a full report (a pushall reply) arrived in this session. */
  get complete(): boolean {
    return this.#complete;
  }

  reset(): void {
    this.#print = {};
    this.#complete = false;
  }

  /** Returns the new status, or null when the payload carried no status. */
  handle(payload: Buffer | string): PrinterStatus | null {
    let message: unknown;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      return null;
    }
    if (!isObject(message)) return null;
    const print = message['print'];
    if (!isObject(print) || print['command'] !== 'push_status') return null;

    this.#print = mergeReport(this.#print, print);
    // Only a full report makes the accumulated state trustworthy.
    if (isFullReport(print)) this.#complete = true;
    return parseStatus(this.#print);
  }
}
