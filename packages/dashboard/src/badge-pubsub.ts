import { EventEmitter } from "node:events";
import type { IssueInfo, PrInfo } from "@kb/core";

/**
 * Badge snapshot message envelope for shared pub/sub.
 * 
 * This contract is used for cross-instance badge updates. Each message includes
 * a sourceId (server instance identifier), taskId, timestamp, and optional
 * prInfo/issueInfo snapshot data.
 * 
 * Explicit null values indicate a badge was removed; omitted fields mean no change
 * to that badge type's data.
 */
export interface BadgePubSubMessage {
  /** Unique identifier for the originating server instance (for deduplication) */
  sourceId: string;
  /** Task identifier */
  taskId: string;
  /** ISO timestamp when the snapshot was captured */
  timestamp: string;
  /** PR badge snapshot data; null = badge cleared; omitted = no change */
  prInfo?: PrInfo | null;
  /** Issue badge snapshot data; null = badge cleared; omitted = no change */
  issueInfo?: IssueInfo | null;
}

/**
 * BadgePubSub adapter interface for cross-instance badge snapshot fan-out.
 * 
 * Implementations must:
 * - Validate incoming messages against the BadgePubSubMessage contract
 * - Emit 'message' events with validated BadgePubSubMessage payloads
 * - Ignore malformed messages without crashing
 * - Support graceful shutdown via dispose()
 */
export interface BadgePubSub extends EventEmitter<BadgePubSubEvents> {
  /** Publish a badge snapshot to the shared bus */
  publish(message: BadgePubSubMessage): void | Promise<void>;
  
  /** Start receiving messages from the shared bus */
  start(): void | Promise<void>;
  
  /** Stop receiving messages and clean up resources */
  dispose(): void | Promise<void>;
}

export interface BadgePubSubEvents {
  message: [BadgePubSubMessage];
  error: [Error];
}

/** Factory function type for creating BadgePubSub instances */
export type BadgePubSubFactory = (options: BadgePubSubFactoryOptions) => BadgePubSub;

export interface BadgePubSubFactoryOptions {
  /** Redis URL (when using Redis adapter) */
  redisUrl?: string;
  /** Pub/sub channel name (when using Redis adapter) */
  channel?: string;
  /** Server instance identifier (for deduplication) */
  sourceId: string;
}

/**
 * In-memory BadgePubSub adapter for single-instance deployments and testing.
 * 
 * This adapter does not actually communicate across instances; it's useful for:
 * - Local single-instance deployments without Redis
 * - Testing multi-instance scenarios with injected shared state
 */
export class InMemoryBadgePubSub extends EventEmitter<BadgePubSubEvents> implements BadgePubSub {
  private started = false;
  private disposed = false;

  publish(message: BadgePubSubMessage): void {
    if (this.disposed) return;
    // In single-instance mode, we immediately emit the message locally
    // This allows tests to verify the publish/subscribe flow
    setImmediate(() => {
      if (!this.disposed) {
        this.emit("message", message);
      }
    });
  }

  start(): void {
    if (this.disposed) return;
    this.started = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.removeAllListeners();
  }
}

/**
 * Redis-backed BadgePubSub adapter for multi-instance deployments.
 * 
 * Requires REDIS_URL environment variable or redisUrl option.
 * Uses Redis pub/sub for cross-instance message delivery.
 * 
 * Environment variables:
 * - KB_BADGE_PUBSUB_REDIS_URL: Redis connection URL
 * - KB_BADGE_PUBSUB_CHANNEL: Channel name (default: "kb:badge-updates")
 */
export class RedisBadgePubSub extends EventEmitter<BadgePubSubEvents> implements BadgePubSub {
  private subscriber: import("ioredis").Redis | null = null;
  private publisher: import("ioredis").Redis | null = null;
  private started = false;
  private disposed = false;
  private readonly redisUrl: string | undefined;
  private readonly channel: string;
  private readonly sourceId: string;

  constructor(options: BadgePubSubFactoryOptions) {
    super();
    this.redisUrl = options.redisUrl ?? getRedisUrlFromEnv();
    this.channel = options.channel ?? getChannelFromEnv();
    this.sourceId = options.sourceId;
  }

  async start(): Promise<void> {
    if (this.disposed || this.started) return;

    const redisUrl = this.redisUrl;
    if (!redisUrl) {
      throw new Error("Redis URL is required for RedisBadgePubSub");
    }

    try {
      const { Redis } = await import("ioredis");
      
      this.subscriber = new Redis(redisUrl);
      this.publisher = new Redis(redisUrl);

      // Handle connection errors without crashing the process
      this.subscriber.on("error", (err: Error) => {
        this.emit("error", new Error(`Redis subscriber error: ${err.message}`));
      });

      this.publisher.on("error", (err: Error) => {
        this.emit("error", new Error(`Redis publisher error: ${err.message}`));
      });

      // Subscribe to channel and handle messages
      await this.subscriber.subscribe(this.channel);
      
      this.subscriber.on("message", (_channel: string, message: string) => {
        if (this.disposed) return;
        
        const parsed = parseBadgePubSubMessage(message, this.sourceId);
        if (parsed.ok) {
          this.emit("message", parsed.value);
        }
        // Silently ignore malformed messages
      });

      this.started = true;
    } catch (err) {
      // Clean up on failure
      await this.cleanupConnections();
      throw err;
    }
  }

  async publish(message: BadgePubSubMessage): Promise<void> {
    if (this.disposed || !this.publisher || !this.started) return;

    try {
      const payload = JSON.stringify(message);
      await this.publisher.publish(this.channel, payload);
    } catch (err) {
      // Emit error but don't crash - caller can decide to retry
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;

    await this.cleanupConnections();
    this.removeAllListeners();
  }

  private async cleanupConnections(): Promise<void> {
    try {
      if (this.subscriber) {
        await this.subscriber.unsubscribe();
        await this.subscriber.quit();
        this.subscriber = null;
      }
    } catch {
      // Ignore cleanup errors
    }

    try {
      if (this.publisher) {
        await this.publisher.quit();
        this.publisher = null;
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Parse and validate a BadgePubSubMessage from a JSON string.
 * 
 * Returns { ok: true, value } for valid messages.
 * Returns { ok: false } for malformed messages (should be silently ignored).
 * 
 * The sourceId check prevents processing our own echoed messages.
 * 
 * @internal Exported for testing purposes
 */
export function parseBadgePubSubMessage(
  json: string,
  localSourceId: string
): { ok: true; value: BadgePubSubMessage } | { ok: false } {
  try {
    const parsed = JSON.parse(json) as Partial<BadgePubSubMessage>;

    // Validate required fields
    if (typeof parsed.sourceId !== "string" || parsed.sourceId.length === 0) {
      return { ok: false };
    }

    // Ignore our own messages (prevent echo loops)
    if (parsed.sourceId === localSourceId) {
      return { ok: false };
    }

    if (typeof parsed.taskId !== "string" || parsed.taskId.length === 0) {
      return { ok: false };
    }

    if (typeof parsed.timestamp !== "string" || parsed.timestamp.length === 0) {
      return { ok: false };
    }

    // Validate prInfo if present (can be null, object, or omitted)
    if (parsed.prInfo !== undefined && parsed.prInfo !== null) {
      if (typeof parsed.prInfo !== "object") {
        return { ok: false };
      }
      // Basic validation of required PrInfo fields
      const pr = parsed.prInfo as Partial<PrInfo>;
      if (typeof pr.url !== "string" || typeof pr.number !== "number") {
        return { ok: false };
      }
    }

    // Validate issueInfo if present (can be null, object, or omitted)
    if (parsed.issueInfo !== undefined && parsed.issueInfo !== null) {
      if (typeof parsed.issueInfo !== "object") {
        return { ok: false };
      }
      // Basic validation of required IssueInfo fields
      const issue = parsed.issueInfo as Partial<IssueInfo>;
      if (typeof issue.url !== "string" || typeof issue.number !== "number") {
        return { ok: false };
      }
    }

    return {
      ok: true,
      value: parsed as BadgePubSubMessage,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Create a BadgePubSub adapter based on environment configuration.
 * 
 * If KB_BADGE_PUBSUB_REDIS_URL is set, returns a RedisBadgePubSub.
 * Otherwise, returns an InMemoryBadgePubSub for local-only operation.
 */
export function createBadgePubSub(options: { sourceId: string }): BadgePubSub {
  const redisUrl = getRedisUrlFromEnv();
  
  if (redisUrl) {
    return new RedisBadgePubSub({
      redisUrl,
      channel: getChannelFromEnv(),
      sourceId: options.sourceId,
    });
  }

  return new InMemoryBadgePubSub();
}

function getRedisUrlFromEnv(): string | undefined {
  return process.env.KB_BADGE_PUBSUB_REDIS_URL;
}

function getChannelFromEnv(): string {
  return process.env.KB_BADGE_PUBSUB_CHANNEL ?? "kb:badge-updates";
}

export { getRedisUrlFromEnv, getChannelFromEnv };
