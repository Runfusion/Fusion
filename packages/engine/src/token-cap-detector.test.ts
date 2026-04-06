import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenCapDetector, type TokenCapCheckResult } from "./token-cap-detector.js";

/** Create a mock AgentSession with the given context usage. */
function createMockSession(
  contextUsage:
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined,
) {
  return {
    getContextUsage: vi.fn(() => contextUsage),
  };
}

describe("TokenCapDetector", () => {
  let detector: TokenCapDetector;

  beforeEach(() => {
    detector = new TokenCapDetector();
  });

  it("does not compact when tokenCap is undefined", async () => {
    const session = createMockSession({
      tokens: 150000,
      contextWindow: 200000,
      percent: 75,
    });
    const compactFn = vi.fn();

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      undefined,
      compactFn,
    );

    expect(result.triggered).toBe(false);
    expect(result.message).toBe("token cap not configured");
    expect(compactFn).not.toHaveBeenCalled();
  });

  it("does not compact when tokens < cap", async () => {
    const session = createMockSession({
      tokens: 100000,
      contextWindow: 200000,
      percent: 50,
    });
    const compactFn = vi.fn();

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      150000,
      compactFn,
    );

    expect(result.triggered).toBe(false);
    expect(result.message).toContain("100000");
    expect(result.message).toContain("150000");
    expect(compactFn).not.toHaveBeenCalled();
  });

  it("compacts when tokens == cap", async () => {
    const session = createMockSession({
      tokens: 100000,
      contextWindow: 200000,
      percent: 50,
    });
    const compactFn = vi.fn().mockResolvedValue({ tokensBefore: 100000 });

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      100000,
      compactFn,
    );

    expect(result.triggered).toBe(true);
    expect(result.tokensBefore).toBe(100000);
    expect(compactFn).toHaveBeenCalledTimes(1);
  });

  it("compacts when tokens > cap", async () => {
    const session = createMockSession({
      tokens: 150000,
      contextWindow: 200000,
      percent: 75,
    });
    const compactFn = vi.fn().mockResolvedValue({ tokensBefore: 150000 });

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      100000,
      compactFn,
    );

    expect(result.triggered).toBe(true);
    expect(result.tokensBefore).toBe(150000);
  });

  it("handles undefined usage gracefully", async () => {
    const session = createMockSession(undefined);
    const compactFn = vi.fn();

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      100000,
      compactFn,
    );

    expect(result.triggered).toBe(false);
    expect(result.message).toBe("context usage unknown");
    expect(compactFn).not.toHaveBeenCalled();
  });

  it("handles null tokens gracefully", async () => {
    const session = createMockSession({
      tokens: null,
      contextWindow: 200000,
      percent: null,
    });
    const compactFn = vi.fn();

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      100000,
      compactFn,
    );

    expect(result.triggered).toBe(false);
    expect(result.message).toBe("context usage unknown");
  });

  it("returns triggered=false when compact fails", async () => {
    const session = createMockSession({
      tokens: 150000,
      contextWindow: 200000,
      percent: 75,
    });
    const compactFn = vi.fn().mockResolvedValue(null);

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      100000,
      compactFn,
    );

    expect(result.triggered).toBe(false);
    expect(result.message).toBe("compaction failed or unavailable");
  });

  it("triggers immediately when tokenCap is 0 and tokens are positive", async () => {
    const session = createMockSession({
      tokens: 1,
      contextWindow: 200000,
      percent: 0,
    });
    const compactFn = vi.fn().mockResolvedValue({ tokensBefore: 1 });

    const result = await detector.checkAndCompact(
      session as any,
      "FN-001",
      0,
      compactFn,
    );

    expect(result.triggered).toBe(true);
    expect(result.tokensBefore).toBe(1);
  });
});
