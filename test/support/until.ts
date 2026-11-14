import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** Polls instead of guessing how long something takes on a busy machine. */
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000, every = 50): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(every);
  }
}
