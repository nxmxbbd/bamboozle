import { isObject, mergeReport, type JsonObject } from './merge.ts';
import { parseStatus, type PrinterStatus } from './status.ts';

/**
 * A pushall reply carries the whole state; deltas carry what changed. One
 * message counts as full only if it alone yields everything the status
 * needs: state, progress, remaining time, error code and a nozzle
 * temperature. It is judged by the status parser itself, so the same rules
 * apply (finite numbers only; on the H2 series the active extruder's entry,
 * else the flat nozzle_temper). A field count is no evidence: a large delta
 * can still miss these.
 */
function isFullReport(print: JsonObject): boolean {
  const status = parseStatus(print);
  return (
    status.gcodeState !== null &&
    status.progress !== null &&
    status.remainingMinutes !== null &&
    // The parser reads a missing error code as 0; a full report has one.
    Number.isFinite(print['print_error']) &&
    status.nozzle !== null
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
