/**
 * One backoff curve, four callers.
 *
 * The bot loops, the Telegram poller and the Discord gateway all retry with the same shape — double the wait
 * each time up to a cap, then hold — and differ only in the cap, which is a property of the remote service
 * (Bot API, Discord REST, the gateway socket), so it stays with the caller.
 */

export type BackoffOptions = {
  /** First wait, before doubling. */
  baseMs?: number;
  /** Longest wait, reached and then held. */
  capMs: number;
  /** How many doublings before the cap applies; a shorter ladder keeps a long outage quiet. */
  maxExponent?: number;
  /** Random share added to avoid several bots retrying in lockstep. */
  jitterMs?: number;
};

/** The wait before retry number `attempt`, where the first retry is 1. */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const { baseMs = 1_000, capMs, maxExponent = 5, jitterMs = 0 } = options;
  const wait = Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 1) - 1, maxExponent));
  return jitterMs > 0 ? wait + Math.random() * jitterMs : wait;
}

/** Wait for the backoff and then run `task`, so a retry loop reads as one line per attempt. */
export async function sleepBackoff(attempt: number, options: BackoffOptions): Promise<void> {
  await new Promise((done) => setTimeout(done, backoffDelay(attempt, options)));
}
