/**
 * The run gate. Five agents may be generating at once; the rest wait in a bounded queue. The limit is
 * part of the product, not a hidden behaviour: the caller gets a lease, a queued label, or a readable
 * refusal, and the fleet view reports the current depth.
 */

export class QueueFullError extends Error {
  readonly queued: number;
  constructor(queued: number) {
    super("the run queue is full (" + queued + " waiting); try again when a run finishes");
    this.name = "QueueFullError";
    this.queued = queued;
  }
}

export type RunLease = {
  readonly label: string;
  readonly queuedMs: number;
  release(): void;
};

type Waiter = {
  label: string;
  queuedAt: number;
  resolve: (lease: RunLease) => void;
  reject: (error: unknown) => void;
};

export class RunLimiter {
  readonly max: number;
  readonly queueLimit: number;
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(max: number, queueLimit: number) {
    this.max = Math.max(1, Math.floor(max));
    this.queueLimit = Math.max(0, Math.floor(queueLimit));
  }

  stats(): { active: number; queued: number; max: number; queueLimit: number; labels: string[] } {
    return {
      active: this.active,
      queued: this.waiting.length,
      max: this.max,
      queueLimit: this.queueLimit,
      labels: this.waiting.map((waiter) => waiter.label),
    };
  }

  /** Take a slot now, wait for one, or refuse when both the slots and the queue are full. */
  acquire(label: string): Promise<RunLease> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.lease(label, 0));
    }
    if (this.waiting.length >= this.queueLimit) return Promise.reject(new QueueFullError(this.waiting.length));
    return new Promise<RunLease>((resolve, reject) => {
      this.waiting.push({ label, queuedAt: Date.now(), resolve, reject });
    });
  }

  private lease(label: string, queuedMs: number): RunLease {
    let released = false;
    return {
      label,
      queuedMs,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        const next = this.waiting.shift();
        if (!next) return;
        this.active += 1;
        next.resolve(this.lease(next.label, Date.now() - next.queuedAt));
      },
    };
  }

  /** Drop every waiter (shutdown). Their callers see a refusal instead of hanging forever. */
  drain(reason = "the daemon is shutting down"): void {
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error(reason));
  }
}
