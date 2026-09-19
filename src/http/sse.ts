/**
 * Server-sent events for the live queue.
 *
 * The hub polls its source and pushes only when the payload actually changes,
 * rather than being notified by every writer. That keeps the engine, the
 * request routes and the admin panel free of any knowledge that a live view
 * exists — anything that changes the queue is reflected automatically.
 *
 * One interval serves every connected phone, so a busy room costs the same as
 * an empty one.
 */
import type { FastifyReply } from 'fastify';
import { log } from '../log.js';

const POLL_MS = 2_000;
/** Comment frames keep proxies and phone radios from dropping an idle stream. */
const HEARTBEAT_MS = 25_000;

export class SseHub<T> {
  readonly #clients = new Set<FastifyReply>();
  readonly #snapshot: () => T;
  #timer: NodeJS.Timeout | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #lastSerialized = '';

  constructor(snapshot: () => T) {
    this.#snapshot = snapshot;
  }

  /** Attach a reply as a live stream. Returns when the client disconnects. */
  add(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Cloudflare and nginx both buffer by default, which would stall SSE.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    this.#clients.add(reply);
    this.#ensureRunning();

    // Send the current state immediately, so a page never renders empty.
    this.#write(reply, this.#serialize());

    const cleanup = (): void => {
      this.#clients.delete(reply);
      if (this.#clients.size === 0) this.#stop();
    };
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Push immediately, without waiting for the next poll. */
  publish(): void {
    const payload = this.#serialize();
    if (payload === this.#lastSerialized) return;
    this.#lastSerialized = payload;
    for (const client of this.#clients) this.#write(client, payload);
  }

  #serialize(): string {
    try {
      return JSON.stringify(this.#snapshot());
    } catch (err) {
      log.error('sse snapshot failed', { err });
      return this.#lastSerialized || '{}';
    }
  }

  #write(reply: FastifyReply, payload: string): void {
    try {
      reply.raw.write(`data: ${payload}\n\n`);
    } catch {
      // A phone that walked out of range; the close handler will clean up.
      this.#clients.delete(reply);
    }
  }

  #ensureRunning(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.publish(), POLL_MS);
    this.#timer.unref?.();
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) {
        try {
          client.raw.write(': ping\n\n');
        } catch {
          this.#clients.delete(client);
        }
      }
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  #stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#timer = null;
    this.#heartbeat = null;
    // Force the next connection to receive a fresh frame.
    this.#lastSerialized = '';
  }

  closeAll(): void {
    for (const client of this.#clients) {
      try {
        client.raw.end();
      } catch {
        // Already gone.
      }
    }
    this.#clients.clear();
    this.#stop();
  }
}
