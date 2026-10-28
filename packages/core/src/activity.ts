/**
 * Which sessions are generating right now.
 *
 * Deliberately in memory: activity is ephemeral, and the durable conversation itself is the source of
 * truth for whether work is still running (see `trackActivity` in sessions.ts). Nothing here is
 * persisted, so a restart simply re-derives it with `trackIfBusy`.
 */
type Active = { epoch: number; startedAt: number };

const active = new Map<string, Active>();
const listeners = new Set<(ids: readonly string[]) => void>();
let epochs = 0;

/** Safety net: a provider that never settles must not pin a spinner in the UI forever. */
export const WATCHDOG_MS = 10 * 60 * 1000;

export function activeIds(): string[] {
  return [...active.keys()];
}

export function isActive(id: string): boolean {
  return active.has(id);
}

export function startedAt(id: string): number | undefined {
  return active.get(id)?.startedAt;
}

export function epochOf(id: string): number | undefined {
  return active.get(id)?.epoch;
}

/** Subscribe to activity changes. The listener receives the whole list, so it never has to diff. */
export function subscribe(listener: (ids: readonly string[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  const ids = activeIds();
  for (const listener of listeners) {
    try {
      listener(ids);
    } catch {
      // One broken listener must not stop the others, and must not fail the generation that marked us.
    }
  }
}

/** Mark a session as generating, returning the epoch that identifies this particular generation. */
export function markActive(id: string): number {
  const epoch = ++epochs;
  active.set(id, { epoch, startedAt: Date.now() });
  emit();
  return epoch;
}

export function markIdle(id: string): void {
  if (active.delete(id)) emit();
}

/**
 * Clear only when no newer generation has started since `epoch`.
 *
 * Without this, a waiter that resolves late would wipe the mark of a generation that began in between:
 * `waitForIdle` can settle at almost the same moment a second submission is placed.
 */
export function markIdleIfCurrent(id: string, epoch: number): void {
  if (active.get(id)?.epoch === epoch) markIdle(id);
}
