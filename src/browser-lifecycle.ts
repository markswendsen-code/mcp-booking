/**
 * Serializes full browser/auth transitions and rejects new browser work while queued.
 * This is an admission gate, not a mutex around every operation: callers must drain
 * search queues themselves; active detail operations may be interrupted by shutdown.
 */
export class BrowserLifecycle {
  // Tail of the transition queue, including auth publication (not just shutdown).
  private shutdown?: Promise<void>;
  private closePromise?: Promise<void>;
  private closeBarrier?: Promise<void>;
  private retiredContexts = new WeakSet<object>();

  assertAvailable(): void {
    if (this.shutdown) throw new Error("Browser is closing or resetting; retry later");
  }

  retire(context: object): void {
    this.retiredContexts.add(context);
  }

  canPersist(context: object): boolean {
    return !this.retiredContexts.has(context);
  }

  close(work: () => Promise<void>): Promise<void> {
    // Only adjacent closes may share work. An intervening auth transition must
    // finish before a later close, so comparing queue-tail identity is essential.
    if (!this.closePromise || this.shutdown !== this.closeBarrier) {
      const barrier = this.exclusive(work);
      this.closeBarrier = barrier;
      const closing = barrier.finally(() => {
        if (this.closePromise === closing) this.closePromise = undefined;
      });
      this.closePromise = closing;
    }
    return this.closePromise;
  }

  /** Queue auth publication without coalescing it away into an existing close. */
  exclusive(work: () => Promise<void>): Promise<void> {
    const previous = this.shutdown;
    const operation = (previous ?? Promise.resolve()).catch(() => {}).then(work);
    const guarded = operation.finally(() => {
      // An earlier transition must not reopen admission if another is queued.
      if (this.shutdown === guarded) this.shutdown = undefined;
    });
    this.shutdown = guarded;
    return guarded;
  }
}
