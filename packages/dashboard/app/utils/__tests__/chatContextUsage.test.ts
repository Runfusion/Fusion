import { describe, expect, it } from "vitest";
import { parseChatContextUsage, resolveChatContextUsage } from "../chatContextUsage";

const measured = { contextUsage: { tokens: 61_234, contextWindow: 200_000, percent: 30.617 } };

describe("resolveChatContextUsage", () => {
  it("uses the labelled estimate for empty, user-only, and legacy threads", () => {
    expect(resolveChatContextUsage({ messages: [], fallbackContextWindow: 200_000 })).toMatchObject({
      source: "estimated", used: 0, total: 200_000, approximate: true,
    });
    expect(resolveChatContextUsage({
      messages: [{ content: "abcd" }, { content: "legacy", metadata: {} }],
      fallbackContextWindow: 200_000,
    })).toMatchObject({ source: "estimated", used: 3, total: 200_000 });
  });

  it("uses a measured anchor exactly when no message follows it", () => {
    expect(resolveChatContextUsage({
      messages: [{ content: "assistant", metadata: measured }],
      fallbackContextWindow: 100,
    })).toEqual({
      source: "measured", used: 61_234, total: 200_000, approximate: false, percent: 30.617,
    });
  });

  it("adds trailing messages and streaming text to a measured anchor", () => {
    expect(resolveChatContextUsage({
      messages: [{ content: "assistant", metadata: measured }, { content: "abcd" }],
      streamingText: "abcdefgh",
      fallbackContextWindow: 100,
    })).toMatchObject({ source: "measured", used: 61_237, approximate: true });
    expect(resolveChatContextUsage({
      messages: [{ content: "assistant", metadata: measured }, { content: "abcd" }],
      streamingText: "abcdefgh",
      fallbackContextWindow: 100,
    })?.percent).toBeCloseTo(30.6185);
  });

  it("uses the newest valid anchor and preserves post-compaction pending state", () => {
    expect(resolveChatContextUsage({
      messages: [{ metadata: measured }, { metadata: { contextUsage: { tokens: 12, contextWindow: 100, percent: 12 } } }],
      fallbackContextWindow: 200_000,
    })).toMatchObject({ source: "measured", used: 12, total: 100 });
    expect(resolveChatContextUsage({
      messages: [{ metadata: measured }, { metadata: { contextUsage: { tokens: null, contextWindow: 200_000, percent: null } } }],
      fallbackContextWindow: 200_000,
    })).toEqual({ source: "pending", used: null, total: 200_000, approximate: false, percent: null });
  });

  it("ignores malformed records and never produces NaN", () => {
    for (const metadata of [null, {}, { contextUsage: null }, { contextUsage: { tokens: 1, contextWindow: 0 } }, { contextUsage: { tokens: 1, contextWindow: -1 } }, { contextUsage: { tokens: "1", contextWindow: 100 } }, { contextUsage: { tokens: 1, contextWindow: Number.POSITIVE_INFINITY } }]) {
      expect(parseChatContextUsage(metadata)).toBeNull();
    }
    expect(resolveChatContextUsage({
      messages: [{ content: "abcd", metadata: { contextUsage: { tokens: "bad", contextWindow: 0 } } }],
      fallbackContextWindow: 200_000,
    })).toMatchObject({ source: "estimated", used: 1 });
  });

  it("uses pi's measured window even when the catalogue has none", () => {
    expect(resolveChatContextUsage({ messages: [{ metadata: measured }], fallbackContextWindow: 0 })).toMatchObject({
      source: "measured", total: 200_000,
    });
    expect(resolveChatContextUsage({ messages: [], fallbackContextWindow: null })).toBeNull();
  });
});
