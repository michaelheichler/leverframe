import type { SelectorDependencies } from './routing-selector.js';

interface SessionCache {
  expiresAt: number;
  entries: SelectorDependencies['cache'];
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_TIMER_MS = 2_147_483_647;

export class RoutingSelectorCache {
  readonly #sessions = new Map<string, SessionCache>();
  readonly #controller = new AbortController();

  get signal(): AbortSignal { return this.#controller.signal; }
  get sessionCount(): number { return this.#sessions.size; }

  forSession(sessionId: string, expiresAt: number, now: number): SelectorDependencies['cache'] {
    if (this.signal.aborted) throw new Error('Routing selector cache is closed.');
    let session = this.#sessions.get(sessionId);
    if (session && session.expiresAt <= now) {
      if (session.timer) clearTimeout(session.timer);
      session.entries.clear();
      this.#sessions.delete(sessionId);
      session = undefined;
    }
    if (!session) {
      session = { expiresAt, entries: new Map() };
      this.#sessions.set(sessionId, session);
    } else session.expiresAt = Math.max(session.expiresAt, expiresAt);
    if (session.timer) clearTimeout(session.timer);
    this.#schedule(sessionId, session, Math.max(1, session.expiresAt - now));
    return session.entries;
  }

  #schedule(sessionId: string, session: SessionCache, remaining: number): void {
    const delay = Math.min(remaining, MAX_TIMER_MS);
    session.timer = setTimeout(() => {
      if (this.#sessions.get(sessionId) !== session) return;
      if (remaining > delay) { this.#schedule(sessionId, session, remaining - delay); return; }
      session.entries.clear();
      this.#sessions.delete(sessionId);
    }, delay);
    session.timer.unref?.();
  }

  dispose(): void {
    if (this.signal.aborted) return;
    this.#controller.abort();
    for (const session of this.#sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
      session.entries.clear();
    }
    this.#sessions.clear();
  }
}
