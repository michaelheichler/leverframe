/**
 * Adapts one SDK callback event source to a cancellable async stream.
 * The iterator has one reader because one connector request owns each source.
 */

export interface EventSession<TEvent> {
  on(handler: (event: TEvent) => void): () => void;
}

export interface EventSubscription<TEvent> {
  subscribe(handler: (event: TEvent) => void): () => void;
}

export interface SessionEventSource<TEvent> extends AsyncIterable<TEvent> {
  close(): void;
}

/** Queues callback events until the stream consumes or closes them. */
export function createSessionEventSource<TEvent>(
  session: EventSession<TEvent> | EventSubscription<TEvent>,
): SessionEventSource<TEvent> {
  const queued: TEvent[] = [];
  let waiting: ((result: IteratorResult<TEvent>) => void) | undefined;
  let closed = false;
  const subscribe = 'on' in session ? session.on.bind(session) : session.subscribe.bind(session);
  const unsubscribe = subscribe(event => {
    if (closed) return;
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ done: false, value: event });
    } else queued.push(event);
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    waiting?.({ done: true, value: undefined });
    waiting = undefined;
  };

  return {
    close,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<TEvent>> {
          const event = queued.shift();
          if (event !== undefined) return Promise.resolve({ done: false, value: event });
          if (closed) return Promise.resolve({ done: true, value: undefined });
          if (waiting !== undefined) {
            return Promise.reject(new Error('Session event source already has a reader'));
          }
          return new Promise(resolve => { waiting = resolve; });
        },
        async return(): Promise<IteratorResult<TEvent>> {
          close();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
