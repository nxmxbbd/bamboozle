import { EventEmitter } from 'node:events';
import type { PrinterStatus } from './printer/status.ts';

/** Anything that produces printer statuses: a real printer or a simulation. */
export interface StatusSource {
  readonly status: PrinterStatus | null;
  readonly online: boolean;
  readonly hasFullStatus: boolean;
  on(event: 'status', listener: (status: PrinterStatus) => void): this;
  on(event: 'online', listener: (online: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  start(): void;
  stop(): Promise<void>;
}

const TOTAL_MINUTES = 222;

/**
 * Status at `t` seconds into a simulated cycle of `cycle` seconds:
 * preparing (0-8 %), printing 0 -> 100 % (8-80 %, with a short fault at
 * the halfway mark), finished (80-88 %), idle (88-100 %).
 */
export function simulatedStatus(t: number, cycle: number): PrinterStatus {
  const phase = ((t % cycle) + cycle) % cycle / cycle;
  let state: PrinterStatus['state'];
  let progress = 0;
  if (phase < 0.08) state = 'preparing';
  else if (phase < 0.8) {
    state = 'printing';
    progress = Math.round(((phase - 0.08) / 0.72) * 100);
  } else if (phase < 0.88) {
    state = 'finished';
    progress = 100;
  } else state = 'idle';

  const active = state === 'preparing' || state === 'printing';
  const fault = state === 'printing' && progress >= 50 && progress < 54;
  const temp = (current: number) => ({ current, target: active ? current : 0 });
  return {
    state,
    gcodeState: { preparing: 'PREPARE', printing: 'RUNNING', finished: 'FINISH', idle: 'IDLE' }[state as string] ?? null,
    progress,
    remainingMinutes: state === 'printing' ? Math.round(TOTAL_MINUTES * (1 - progress / 100)) : 0,
    layer: Math.round(progress * 1.2),
    totalLayers: 120,
    nozzles: [{ id: 0, ...temp(active ? 265 : 40) }],
    activeNozzleId: 0,
    nozzle: temp(active ? 265 : 40),
    bed: temp(active ? 100 : 30),
    chamber: temp(active ? 30 + Math.round(progress / 4) : 28),
    chamberLight: true,
    hms: [],
    printError: fault ? 0x0300_8008 : 0,
    signatureRequired: false,
  };
}

export class SimulatedPrinter extends EventEmitter<{ status: [PrinterStatus]; online: [boolean]; error: [Error] }> implements StatusSource {
  readonly #cycleSeconds: number;
  readonly #tickMs: number;
  #timer: NodeJS.Timeout | null = null;
  #started = 0;
  #status: PrinterStatus | null = null;

  constructor(options: { cycleSeconds?: number; tickMs?: number } = {}) {
    super();
    this.#cycleSeconds = options.cycleSeconds ?? 180;
    this.#tickMs = options.tickMs ?? 2000;
  }

  get status(): PrinterStatus | null {
    return this.#status;
  }

  get online(): boolean {
    return this.#timer !== null;
  }

  get hasFullStatus(): boolean {
    return this.#status !== null;
  }

  start(): void {
    if (this.#timer) return;
    this.#started = Date.now();
    const tick = () => {
      this.#status = simulatedStatus((Date.now() - this.#started) / 1000, this.#cycleSeconds);
      this.emit('status', this.#status);
    };
    this.#timer = setInterval(tick, this.#tickMs);
    this.emit('online', true);
    tick();
  }

  async stop(): Promise<void> {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.emit('online', false);
  }
}
