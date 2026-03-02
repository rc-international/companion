/**
 * Fire-and-forget Redis publisher for Companion.
 *
 * Publishes session events to the same channels that the tutor engine
 * subscribes to (`wilco:session:{id}:output` and `wilco:session:{id}:input`).
 *
 * Gracefully optional: if Redis is unavailable, logs a warning and never crashes.
 */

import Redis from "ioredis";

const DEFAULT_REDIS_URL = "redis://localhost:6379";

export class CompanionRedisPublisher {
  private client: Redis | null = null;
  private connected = false;
  private redisUrl: string;

  constructor(redisUrl?: string) {
    this.redisUrl = redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  }

  async connect(): Promise<void> {
    try {
      this.client = new Redis(this.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 5) return null; // give up after 5 retries
          return Math.min(times * 1000, 5000);
        },
      });

      this.client.on("connect", () => {
        this.connected = true;
        console.log("[redis-publisher] Connected");
      });

      this.client.on("error", (err) => {
        console.warn("[redis-publisher] Error:", err.message);
      });

      this.client.on("close", () => {
        this.connected = false;
      });

      await this.client.connect();
    } catch (err) {
      console.warn("[redis-publisher] Failed to connect (tutor events will not be published):", (err as Error).message);
      this.client = null;
    }
  }

  /**
   * Fire-and-forget publish. Never throws.
   */
  publish(channel: string, event: Record<string, unknown>): void {
    if (!this.client || !this.connected) return;
    const payload = JSON.stringify(event);
    this.client.publish(channel, payload).catch((err) => {
      console.warn(`[redis-publisher] Publish failed on ${channel}:`, err.message);
    });
  }

  publishOutput(sessionId: string, event: Record<string, unknown>): void {
    this.publish(`wilco:session:${sessionId}:output`, event);
  }

  publishInput(sessionId: string, event: Record<string, unknown>): void {
    this.publish(`wilco:session:${sessionId}:input`, event);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.client = null;
      this.connected = false;
    }
  }
}
