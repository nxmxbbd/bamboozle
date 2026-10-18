import { isObject, mergeReport, type JsonObject } from './merge.ts';
import { parseStatus, type PrinterStatus } from './status.ts';

/** A report with at least this many fields is a full pushall reply, not a delta. */
export const FULL_REPORT_FIELDS = 30;

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
    // A pushall reply carries the whole state (~100 fields); deltas carry a
    // handful. Only a full report makes the accumulated state trustworthy.
    if (Object.keys(print).length >= FULL_REPORT_FIELDS && typeof print['gcode_state'] === 'string') this.#complete = true;
    return parseStatus(this.#print);
  }
}
