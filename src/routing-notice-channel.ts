import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { acknowledgeRoutingNotice, awaitRoutingNotice, listRoutingNotices, type NoticeAcknowledgmentInput, type RoutingNoticeIdentity } from './routing-bindings.js';

const CONSUMER_TTL_MS = 300_000;
const POLL_INTERVAL_MS = 100;
const MAX_BUFFERED_BYTES = 65_536;
interface NoticeConnection {
  id: string;
  response: ServerResponse;
  controller: AbortController;
  delivered: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}
interface NoticeConsumer {
  id: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  connection?: NoticeConnection;
}

function eventKey(input: Pick<RoutingNoticeIdentity, 'sequence' | 'modelId' | 'revision'>): string {
  return JSON.stringify([input.sequence, input.modelId, input.revision]);
}

export class RoutingNoticeChannel {
  readonly #sessions = new Map<string, NoticeConsumer>();
  #closed = false;

  register(sessionId: string): { consumerId: string; expiresAt: string } {
    if (this.#closed) throw new Error('Routing notice channel is closed.');
    this.#remove(sessionId, this.#sessions.get(sessionId));
    const expiresAt = Date.now() + CONSUMER_TTL_MS;
    const consumer: NoticeConsumer = { id: randomUUID(), expiresAt, timer: setTimeout(() => this.#remove(sessionId, consumer), CONSUMER_TTL_MS) };
    consumer.timer.unref?.();
    this.#sessions.set(sessionId, consumer);
    return { consumerId: consumer.id, expiresAt: new Date(expiresAt).toISOString() };
  }

  renew(sessionId: string, consumerId: string): { consumerId: string; expiresAt: string } | undefined {
    if (this.#closed) return undefined;
    const consumer = this.#active(sessionId, consumerId);
    if (!consumer) return undefined;
    clearTimeout(consumer.timer);
    consumer.expiresAt = Date.now() + CONSUMER_TTL_MS;
    consumer.timer = setTimeout(() => this.#remove(sessionId, consumer), CONSUMER_TTL_MS);
    consumer.timer.unref?.();
    return { consumerId: consumer.id, expiresAt: new Date(consumer.expiresAt).toISOString() };
  }

  connect(sessionId: string, consumerId: string, after: number, response: ServerResponse): boolean {
    if (this.#closed) return false;
    const consumer = this.#active(sessionId, consumerId);
    if (!consumer) return false;
    this.#disconnect(consumer, consumer.connection);
    const connection: NoticeConnection = { id: randomUUID(), response, controller: new AbortController(), delivered: new Set() };
    consumer.connection = connection;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.on('close', () => this.#disconnect(consumer, connection));
    response.on('error', () => this.#disconnect(consumer, connection));
    response.flushHeaders();
    let cursor = after;
    const pump = () => {
      if (this.#active(sessionId, consumerId) !== consumer || consumer.connection !== connection
        || response.destroyed || response.writableEnded || response.writableLength > MAX_BUFFERED_BYTES) {
        this.#disconnect(consumer, connection);
        return;
      }
      try {
        for (const notice of listRoutingNotices(sessionId, cursor)) {
          cursor = Math.max(cursor, notice.sequence);
          if (notice.acknowledged) continue;
          const key = eventKey(notice);
          if (connection.delivered.has(key)) continue;
          response.write(`event: routing-notice\nid: ${notice.sequence}\ndata: ${JSON.stringify(notice)}\n\n`);
          connection.delivered.add(key);
          if (response.writableLength > MAX_BUFFERED_BYTES) { this.#disconnect(consumer, connection); return; }
        }
      } catch { this.#disconnect(consumer, connection); return; }
      connection.timer = setTimeout(pump, POLL_INTERVAL_MS);
      connection.timer.unref?.();
    };
    pump();
    return true;
  }

  async acknowledge(input: RoutingNoticeIdentity & { consumerId: string }): Promise<boolean> {
    if (this.#closed) return false;
    const consumer = this.#active(input.sessionId, input.consumerId);
    const connection = consumer?.connection;
    if (!connection || connection.controller.signal.aborted || connection.response.destroyed || connection.response.writableEnded) return false;
    if (!connection.delivered.has(eventKey(input))) {
      const saved = listRoutingNotices(input.sessionId, 0).find(notice => eventKey(notice) === eventKey(input));
      return saved?.acknowledged === true;
    }
    await acknowledgeRoutingNotice(input);
    connection.delivered.delete(eventKey(input));
    return true;
  }

  signal(sessionId: string): AbortSignal | undefined {
    if (this.#closed) return undefined;
    const consumer = this.#sessions.get(sessionId);
    const connection = consumer && this.#active(sessionId, consumer.id)?.connection;
    return connection && !connection.response.destroyed && !connection.response.writableEnded ? connection.controller.signal : undefined;
  }

  capture(sessionId: string): { sessionId: string; consumerId: string; connectionId: string; signal: AbortSignal } | undefined {
    if (this.#closed) return undefined;
    const consumer = this.#sessions.get(sessionId);
    const connection = consumer && this.#active(sessionId, consumer.id)?.connection;
    return consumer && connection && !connection.response.destroyed && !connection.response.writableEnded && !connection.controller.signal.aborted
      ? { sessionId, consumerId: consumer.id, connectionId: connection.id, signal: connection.controller.signal } : undefined;
  }

  async wait(input: NoticeAcknowledgmentInput): Promise<void> {
    const signal = this.signal(input.sessionId);
    if (!signal) throw Object.assign(new Error('Routing notice consumer is unavailable.'), { code: 'routing_notice_unavailable' });
    await awaitRoutingNotice({ ...input, signal: AbortSignal.any([input.signal, signal]) });
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [sessionId, consumer] of this.#sessions) this.#remove(sessionId, consumer);
  }

  #active(sessionId: string, consumerId: string): NoticeConsumer | undefined {
    const consumer = this.#sessions.get(sessionId);
    if (!consumer || consumer.id !== consumerId) return undefined;
    if (Date.now() >= consumer.expiresAt) { this.#remove(sessionId, consumer); return undefined; }
    return consumer;
  }

  #disconnect(consumer: NoticeConsumer, connection: NoticeConnection | undefined): void {
    if (!connection || consumer.connection !== connection) return;
    consumer.connection = undefined;
    if (connection.timer) clearTimeout(connection.timer);
    connection.controller.abort();
    if (!connection.response.destroyed && !connection.response.writableEnded) connection.response.end();
  }

  #remove(sessionId: string, consumer: NoticeConsumer | undefined): void {
    if (!consumer || this.#sessions.get(sessionId) !== consumer) return;
    this.#sessions.delete(sessionId);
    clearTimeout(consumer.timer);
    this.#disconnect(consumer, consumer.connection);
  }
}
