import { Accessory, Characteristic, HapStatusError, Service, uuid, type CharacteristicValue } from '@homebridge/hap-nodejs';
import type { PrinterStatus } from '../printer/status.ts';
import { runResumeCommand, type ResumeResult, type ResumeRunOptions } from '../resume.ts';
import { VERSION } from '../version.ts';
import {
  CATEGORY_SWITCH,
  STATUS_COMMUNICATION_FAILURE,
  STATUS_NOT_ALLOWED_IN_CURRENT_STATE,
  STATUS_RESOURCE_BUSY,
} from './hap-constants.ts';
import { SNAP_BACK_MS } from './printer-accessory.ts';
import { homeKitName } from './names.ts';

/** How long a failed resume shows as "No Response" on the switch. */
export const RESUME_FAILURE_MS = 30_000;
/** How long an accepted resume blocks the next press while the printer still reports paused. */
export const RESUMED_HOLD_MS = 60_000;

type Runner = (argv: readonly string[], printerName: string, options: ResumeRunOptions) => Promise<ResumeResult>;

export interface ResumeControlOptions {
  name: string;
  serial: string;
  model?: string;
  /** printers[].resumeCommand */
  command: readonly string[];
  log: Pick<Console, 'log' | 'warn'>;
  /** Replaces running the command (tests). */
  run?: Runner;
}

/**
 * A momentary "Resume" switch for one printer, on its own tile. Turning it on
 * while the printer is paused runs the configured command; the switch stays on
 * while it runs and goes off when it is done. Turning it off does nothing, so
 * a scene that turns everything off cannot resume a print. A press the printer
 * cannot take (not paused, unreachable, a run still going) is refused with an
 * error the Home app shows; a run that fails shows "No Response" for a while.
 * The command can take longer than the Home app waits for a write, which is
 * why its result is shown afterwards and not as the write's answer.
 */
export class ResumeControl {
  readonly accessory: Accessory;
  readonly #options: ResumeControlOptions;
  readonly #on: Characteristic;
  readonly #run: Runner;
  readonly #abort = new AbortController();
  #status: PrinterStatus | null = null;
  #available = false;
  #running: Promise<void> | null = null;
  #failedUntil = 0;
  #failureTimer: NodeJS.Timeout | null = null;
  /** An accepted resume the printer has not reported yet (it still says paused). */
  #resumedAt: number | null = null;
  /** The printer reported something else than paused while the command ran. */
  #leftPause = false;

  constructor(options: ResumeControlOptions) {
    this.#options = options;
    this.#run = options.run ?? runResumeCommand;
    const name = homeKitName(`${options.name} Resume`);
    this.accessory = new Accessory(name, uuid.generate(`bamboozle:${options.serial}:resume`));
    this.accessory.category = CATEGORY_SWITCH;
    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Bambu Lab')
      .setCharacteristic(Characteristic.Model, options.model ?? '3D printer')
      .setCharacteristic(Characteristic.SerialNumber, options.serial)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
    const service = this.accessory.addService(Service.Switch, name, 'resume');
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    this.#on = service.getCharacteristic(Characteristic.On);
    this.#on.updateValue(false);
    this.#on.onGet(() => this.#shown());
    this.#on.onSet((value) => this.#press(value));
  }

  /** The printer's latest state, from every status report. */
  update(status: PrinterStatus | null, available: boolean): void {
    this.#status = status;
    this.#available = available && status !== null;
    // Only a report that the pause is over ends the hold: a lost connection,
    // or a state bamboozle does not know (unknown), says nothing about it.
    if (available && status !== null && status.state !== 'paused' && status.state !== 'unknown') {
      this.#resumedAt = null;
      if (this.#running) this.#leftPause = true;
    }
    this.#push();
  }

  /** Stop taking presses and end a running command. */
  async stop(): Promise<void> {
    this.#abort.abort();
    if (this.#failureTimer) clearTimeout(this.#failureTimer);
    await this.#running;
  }

  #shown(): boolean {
    if (!this.#available || Date.now() < this.#failedUntil) throw new HapStatusError(STATUS_COMMUNICATION_FAILURE);
    return this.#running !== null;
  }

  #push(): void {
    try {
      this.#on.updateValue(this.#shown());
    } catch (error) {
      this.#on.updateValue(error as HapStatusError);
    }
  }

  #press(value: CharacteristicValue): void {
    if (!value) {
      // Off is never an action: show the real state again.
      setTimeout(() => this.#push(), SNAP_BACK_MS).unref();
      return;
    }
    if (this.#abort.signal.aborted || !this.#available) throw new HapStatusError(STATUS_COMMUNICATION_FAILURE);
    // A double tap, or an automation firing twice, before the printer
    // reported the last resume must not send another one.
    if (this.#running || (this.#resumedAt !== null && Date.now() - this.#resumedAt < RESUMED_HOLD_MS)) throw new HapStatusError(STATUS_RESOURCE_BUSY);
    if (this.#status?.state !== 'paused') throw new HapStatusError(STATUS_NOT_ALLOWED_IN_CURRENT_STATE);
    const { name, command, log } = this.#options;
    log.log(`[${name}] resume requested from the Home app`);
    this.#failedUntil = 0;
    this.#leftPause = false;
    this.#running = this.#run(command, name, { signal: this.#abort.signal }).then(
      (result) => this.#finished(result),
      (error: unknown) => this.#finished({ ok: false, message: (error as Error).message }),
    );
  }

  #finished(result: ResumeResult): void {
    const { name, log } = this.#options;
    this.#running = null;
    // bamboozle is stopping: not a resume that failed.
    if (this.#abort.signal.aborted) return;
    if (result.ok) {
      // Already seen leaving that pause: a pause from now on is a new one.
      if (!this.#leftPause) this.#resumedAt = Date.now();
      log.log(`[${name}] resume accepted${result.message ? `: ${result.message}` : ''}`);
    } else {
      log.warn(`[${name}] resume failed: ${result.message}`);
      this.#failedUntil = Date.now() + RESUME_FAILURE_MS;
      if (this.#failureTimer) clearTimeout(this.#failureTimer);
      this.#failureTimer = setTimeout(() => this.#push(), RESUME_FAILURE_MS).unref();
    }
    this.#push();
  }
}
