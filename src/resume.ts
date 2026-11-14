import { spawn } from 'node:child_process';

// The Resume control does not talk to the printer itself: it runs a command
// the operator configured (printers[].resumeCommand) and reports what it says.
// Contract with that command: argv as configured, no shell; the environment
// holds BAMBOOZLE_PRINTER (the printer's name) and a fixed PATH, nothing of
// bamboozle's own; it must finish within 30 s; exit 0 = the resume was
// accepted, anything else = refused or failed; one short line on stdout may
// say why, and bamboozle logs it. It runs in /. Each run is its own process
// group, and the whole group is ended with it. Whatever it does, bamboozle has
// its answer after 30 s at the latest.

const RESUME_TIMEOUT_MS = 30_000;
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
// Enough for one line; a chatty command is cut off, not buffered.
const MAX_OUTPUT_BYTES = 4096;
const MAX_MESSAGE = 200;
// After the command exits, how long its output may stay open (something it
// started in a session of its own) before bamboozle stops reading.
const OUTPUT_GRACE_MS = 1000;

export interface ResumeResult {
  ok: boolean;
  /** The first output line (or what went wrong), printable and short. */
  message: string;
}

export interface ResumeRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function firstLine(output: Buffer): string {
  const line = output.toString('utf8').split('\n', 1)[0] ?? '';
  return line.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
}

export function runResumeCommand(argv: readonly string[], printerName: string, options: ResumeRunOptions = {}): Promise<ResumeResult> {
  const timeoutMs = options.timeoutMs ?? RESUME_TIMEOUT_MS;
  return new Promise((resolve) => {
    const [file = '', ...args] = argv;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (options.signal?.aborted) return resolve({ ok: false, message: 'stopped' });
    const child = spawn(file, args, {
      env: { PATH, BAMBOOZLE_PRINTER: printerName },
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: '/',
      detached: true,
    });
    // First, so a spawn that fails outright (no such file, out of file
    // descriptors: then there is no stdout either) is an answer, not a crash.
    child.on('error', (error: NodeJS.ErrnoException) => done({ ok: false, message: `cannot run ${file}: ${error.code ?? error.message}` }));
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      aborted = true;
      killGroup();
      finish();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let grace: NodeJS.Timeout | undefined;
    const done = (result: ResumeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      resolve(result);
    };
    // The answer, from what is known now: also when the output never closes.
    const finish = () => {
      const line = firstLine(Buffer.concat(chunks));
      if (aborted) return done({ ok: false, message: 'stopped' });
      if (timedOut) return done({ ok: false, message: `no answer within ${timeoutMs / 1000} s` });
      if (exitCode === 0) return done({ ok: true, message: line });
      const why = exitCode !== null ? `exit ${exitCode}` : `killed by ${exitSignal}`;
      done({ ok: false, message: line ? `${why}: ${line}` : why });
    };
    const timer = setTimeout(() => {
      // It answered in time and only its output is still open: its exit code counts.
      if (exitCode !== null || exitSignal !== null) return finish();
      timedOut = true;
      killGroup();
      finish();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - bytes));
      bytes += chunk.byteLength;
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Whatever it left running in its group would keep the output open.
      killGroup();
      if (!settled) grace = setTimeout(finish, OUTPUT_GRACE_MS);
    });
    child.on('close', finish);
  });
}
