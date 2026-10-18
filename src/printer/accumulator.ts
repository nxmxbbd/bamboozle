import { isObject, mergeReport, type JsonObject } from './merge.ts';
import { parseStatus, type PrinterStatus } from './status.ts';

/**
 * Turns raw MQTT report payloads into successive statuses. Only
 * `push_status` messages are merged; command replies that share the topic
 * (get_version, calibration results, ...) are ignored.
 */
export class ReportAccumulator {
  #print: JsonObject = {};
  #complete = false;

  /** True once a status with a `gcode_state` (a full pushall reply) arrived. */
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
    const status = parseStatus(this.#print);
    if (status.gcodeState !== null) this.#complete = true;
    return status;
  }
}
