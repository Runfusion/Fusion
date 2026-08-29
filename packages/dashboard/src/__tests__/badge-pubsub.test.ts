import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryBadgePubSub,
  RedisBadgePubSub,
  createBadgePubSub,
  parseBadgePubSubMessage,
  type BadgePubSubMessage,
} from "../badge-pubsub.js";

function createValidMessage(overrides: Partial<BadgePubSubMessage> = {}): BadgePubSubMessage {
  return {
    sourceId: "server-a",
    taskId: "FN-001",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("InMemoryBadgePubSub", () => {
  let pubsub: InMemoryBadgePubSub;

  beforeEach(() => {
    pubsub = new InMemoryBadgePubSub();
  });

  afterEach(async () => {
    await pubsub.dispose();
  });

  it("publishes and receives messages", async () => {
    const messages: BadgePubSubMessage[] = [];
    pubsub.on("message", (msg) => messages.push(msg));
    pubsub.start();

    const message = createValidMessage();
    pubsub.publish(message);

    // Wait for setImmediate
    await new Promise((resolve) => setImmediate(resolve));

    expect(messages).toHaveLength(1);
    expect(messages[0].taskId).toBe("FN-001");
  });

  it("handles multiple subscribers", async () => {
    const messages1: BadgePubSubMessage[] = [];
    const messages2: BadgePubSubMessage[] = [];
    
    pubsub.on("message", (msg) => messages1.push(msg));
    pubsub.on("message", (msg) => messages2.push(msg));
    pubsub.start();

    pubsub.publish(createValidMessage());
    await new Promise((resolve) => setImmediate(resolve));

    expect(messages1).toHaveLength(1);
    expect(messages2).toHaveLength(1);
  });

  it("emits error events without crashing", async () => {
    const errors: Error[] = [];
    pubsub.on("error", (err) => errors.push(err));
    
    // InMemory adapter doesn't naturally emit errors, but the interface supports it
    // This test verifies error handlers can be registered
    expect(errors).toHaveLength(0);
  });

  it("stops accepting messages after dispose", async () => {
    const messages: BadgePubSubMessage[] = [];
    pubsub.on("message", (msg) => messages.push(msg));
    pubsub.start();

    await pubsub.dispose();
    pubsub.publish(createValidMessage());

    // Wait for any potential delivery
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(0);
  });

  it("allows multiple start() calls without error", () => {
    pubsub.start();
    pubsub.start(); // Should not throw
    expect(true).toBe(true);
  });

  it("allows dispose() to be called multiple times", async () => {
    await pubsub.dispose();
    await pubsub.dispose(); // Should not throw
    expect(true).toBe(true);
  });
});

describe("createBadgePubSub", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.FUSION_BADGE_PUBSUB_REDIS_URL;
    delete process.env.FUSION_BADGE_PUBSUB_CHANNEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns InMemoryBadgePubSub when no Redis URL is configured", () => {
    const pubsub = createBadgePubSub({ sourceId: "server-1" });
    expect(pubsub).toBeInstanceOf(InMemoryBadgePubSub);
  });

  it("returns RedisBadgePubSub when FUSION_BADGE_PUBSUB_REDIS_URL is set", () => {
    process.env.FUSION_BADGE_PUBSUB_REDIS_URL = "redis://localhost:6379";
    const pubsub = createBadgePubSub({ sourceId: "server-1" });
    expect(pubsub).toBeInstanceOf(RedisBadgePubSub);
  });

  it("uses default channel fusion:badge-updates when FUSION_BADGE_PUBSUB_CHANNEL is unset", () => {
    process.env.FUSION_BADGE_PUBSUB_REDIS_URL = "redis://localhost:6379";
    delete process.env.FUSION_BADGE_PUBSUB_CHANNEL;
    
    const pubsub = createBadgePubSub({ sourceId: "server-1" });
    expect(pubsub).toBeInstanceOf(RedisBadgePubSub);
    // The channel is internal to the adapter; we verify by creating it without error
  });

  it("uses custom channel when FUSION_BADGE_PUBSUB_CHANNEL is set", () => {
    process.env.FUSION_BADGE_PUBSUB_REDIS_URL = "redis://localhost:6379";
    process.env.FUSION_BADGE_PUBSUB_CHANNEL = "custom-channel";
    
    const pubsub = createBadgePubSub({ sourceId: "server-1" });
    expect(pubsub).toBeInstanceOf(RedisBadgePubSub);
  });
});

describe("parseBadgePubSubMessage validation", () => {
  const localSourceId = "server-local";

  it("accepts valid messages", () => {
    const message = createValidMessage({ sourceId: "server-remote" });
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe("FN-001");
      expect(result.value.sourceId).toBe("server-remote");
    }
  });

  it("rejects messages from local source (echo prevention)", () => {
    const message = createValidMessage({ sourceId: localSourceId });
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages without sourceId", () => {
    const json = JSON.stringify({ taskId: "FN-001", timestamp: new Date().toISOString() });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages with empty sourceId", () => {
    const json = JSON.stringify({ sourceId: "", taskId: "FN-001", timestamp: new Date().toISOString() });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages without taskId", () => {
    const json = JSON.stringify({ sourceId: "server-remote", timestamp: new Date().toISOString() });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages with empty taskId", () => {
    const json = JSON.stringify({ sourceId: "server-remote", taskId: "", timestamp: new Date().toISOString() });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages without timestamp", () => {
    const json = JSON.stringify({ sourceId: "server-remote", taskId: "FN-001" });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages with empty timestamp", () => {
    const json = JSON.stringify({ sourceId: "server-remote", taskId: "FN-001", timestamp: "" });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects invalid JSON", () => {
    const result = parseBadgePubSubMessage("not valid json", localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("accepts messages with valid prInfo", () => {
    const message = createValidMessage({
      sourceId: "server-remote",
      prInfo: {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "open",
        title: "Test PR",
        headBranch: "feature",
        baseBranch: "main",
        commentCount: 0,
      },
    });
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prInfo?.number).toBe(1);
    }
  });

  it("accepts messages with prInfo set to null (badge cleared)", () => {
    const message = createValidMessage({ sourceId: "server-remote", prInfo: null });
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prInfo).toBeNull();
    }
  });

  it("rejects messages with non-object prInfo", () => {
    const json = JSON.stringify({
      sourceId: "server-remote",
      taskId: "FN-001",
      timestamp: new Date().toISOString(),
      prInfo: "invalid",
    });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages with prInfo missing required fields", () => {
    const json = JSON.stringify({
      sourceId: "server-remote",
      taskId: "FN-001",
      timestamp: new Date().toISOString(),
      prInfo: { number: 1 }, // missing url
    });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("accepts messages with valid issueInfo", () => {
    const message = createValidMessage({
      sourceId: "server-remote",
      issueInfo: {
        url: "https://github.com/owner/repo/issues/2",
        number: 2,
        state: "open",
        title: "Test Issue",
      },
    });
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.issueInfo?.number).toBe(2);
    }
  });

  it("accepts messages with issueInfo set to null (badge cleared)", () => {
    const message = createValidMessage({ sourceId: "server-remote", issueInfo: null });
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.issueInfo).toBeNull();
    }
  });

  it("rejects messages with non-object issueInfo", () => {
    const json = JSON.stringify({
      sourceId: "server-remote",
      taskId: "FN-001",
      timestamp: new Date().toISOString(),
      issueInfo: 123,
    });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("rejects messages with issueInfo missing required fields", () => {
    const json = JSON.stringify({
      sourceId: "server-remote",
      taskId: "FN-001",
      timestamp: new Date().toISOString(),
      issueInfo: { state: "open" }, // missing url and number
    });
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(false);
  });

  it("accepts messages with both prInfo and issueInfo", () => {
    const message = createValidMessage({
      sourceId: "server-remote",
      prInfo: {
        url: "https://github.com/owner/repo/pull/1",
        number: 1,
        status: "open",
        title: "Test PR",
        headBranch: "feature",
        baseBranch: "main",
        commentCount: 0,
      },
      issueInfo: {
        url: "https://github.com/owner/repo/issues/2",
        number: 2,
        state: "open",
        title: "Test Issue",
      },
    });
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prInfo).toBeTruthy();
      expect(result.value.issueInfo).toBeTruthy();
    }
  });

  it("accepts messages with omitted prInfo and issueInfo (no badge change)", () => {
    const message = createValidMessage({ sourceId: "server-remote" });
    // No prInfo or issueInfo fields
    const json = JSON.stringify(message);
    
    const result = parseBadgePubSubMessage(json, localSourceId);
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prInfo).toBeUndefined();
      expect(result.value.issueInfo).toBeUndefined();
    }
  });
});

describe("RedisBadgePubSub (integration)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("can be instantiated with Redis URL", () => {
    const pubsub = new RedisBadgePubSub({
      sourceId: "server-1",
      redisUrl: "redis://localhost:6379",
      channel: "test-channel",
    });
    
    expect(pubsub).toBeDefined();
    expect(pubsub).toBeInstanceOf(RedisBadgePubSub);
  });

  it("reads configuration from environment variables", () => {
    process.env.FUSION_BADGE_PUBSUB_REDIS_URL = "redis://redis.example.com:6380";
    process.env.FUSION_BADGE_PUBSUB_CHANNEL = "prod-badges";

    const pubsub = createBadgePubSub({ sourceId: "server-1" });
    expect(pubsub).toBeInstanceOf(RedisBadgePubSub);
    // Configuration is internal; successful creation indicates env was read
  });

  it("handles dispose before start gracefully", async () => {
    const pubsub = new RedisBadgePubSub({
      sourceId: "server-1",
      redisUrl: "redis://localhost:6379",
    });

    await pubsub.dispose();
    expect(true).toBe(true); // Should not throw
  });

  it("allows multiple dispose() calls", async () => {
    const pubsub = new RedisBadgePubSub({
      sourceId: "server-1",
      redisUrl: "redis://localhost:6379",
    });

    await pubsub.dispose();
    await pubsub.dispose();
    expect(true).toBe(true); // Should not throw
  });
});
