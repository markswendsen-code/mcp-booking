import { randomUUID } from "node:crypto";

interface ClosablePage {
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface SearchSession<P, R> {
  id: string;
  key: string;
  page: P;
  initialized: boolean;
  results: R[];
}

interface ManagedSession<P, R> extends SearchSession<P, R> {
  busy: number;
  lastUsed: number;
  tail: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Bounded browser sessions: separate pages across searches, a queue within each. */
export class SearchSessions<P extends ClosablePage, R> {
  private sessions = new Map<string, ManagedSession<P, R>>();
  private allocation: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private createPage: () => Promise<P>,
    private maxSessions = 8,
    private idleMs = 10 * 60 * 1000,
    private now: () => number = Date.now
  ) {}

  private async remove(session: ManagedSession<P, R>): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    clearTimeout(session.timer);
    if (!session.page.isClosed()) await session.page.close();
  }

  private lookup(id: string): ManagedSession<P, R> {
    const session = this.sessions.get(id);
    if (!session || session.page.isClosed() ||
      (!session.busy && this.now() - session.lastUsed >= this.idleMs)) {
      if (session) void this.remove(session).catch(() => {});
      throw new Error("Unknown or expired searchId; start a new search without searchId");
    }
    return session;
  }

  private allocate(key: string): Promise<ManagedSession<P, R>> {
    const result = this.allocation.then(async () => {
      if (this.closing) throw new Error("Search sessions are closing; retry later");
      if (this.sessions.size >= this.maxSessions) {
        const idle = [...this.sessions.values()].filter((s) => !s.busy)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new Error("All search sessions are busy; retry after a search completes");
        await this.remove(idle);
      }
      const page = await this.createPage();
      if (this.closing) {
        await page.close();
        throw new Error("Search sessions are closing; retry later");
      }
      const session: ManagedSession<P, R> = {
        id: randomUUID(), key, page, initialized: false, results: [],
        busy: 1, lastUsed: this.now(), tail: Promise.resolve(),
      };
      this.sessions.set(session.id, session);
      return session;
    });
    this.allocation = result.then(() => {}, () => {});
    return result;
  }

  async run(
    key: string,
    id: string | undefined,
    work: (session: SearchSession<P, R>) => Promise<R[]>
  ): Promise<{ searchId: string; properties: R[] }> {
    if (this.closing) throw new Error("Search sessions are closing; retry later");
    let session: ManagedSession<P, R>;
    if (id !== undefined) {
      session = this.lookup(id);
      if (session.key !== key) {
        throw new Error("searchId belongs to different search criteria; omit searchId to start a new search");
      }
      session.busy++;
      clearTimeout(session.timer);
    } else {
      session = await this.allocate(key);
    }

    const result = session.tail.then(async () => {
      if (this.sessions.get(session.id) !== session || session.page.isClosed()) {
        throw new Error("Search session closed; start a new search without searchId");
      }
      try {
        const properties = await work(session);
        session.results = properties;
        return { searchId: session.id, properties };
      } catch (error) {
        await this.remove(session).catch(() => {});
        throw error;
      }
    });
    session.tail = result.then(() => {}, () => {});
    try {
      return await result;
    } finally {
      session.busy--;
      session.lastUsed = this.now();
      if (!session.busy && this.sessions.get(session.id) === session) {
        session.timer = setTimeout(() => {
          void this.remove(session).catch(() => {});
        }, this.idleMs);
        session.timer.unref();
      }
    }
  }

  getResults(id: string): R[] {
    return [...this.lookup(id).results];
  }

  closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = Promise.resolve().then(async () => {
      await this.allocation;
      const sessions = [...this.sessions.values()];
      await Promise.all(sessions.map(async (session) => {
        await session.tail;
        await this.remove(session);
      }));
    }).finally(() => {
      this.closing = false;
      this.closePromise = undefined;
    });
    return this.closePromise;
  }
}
