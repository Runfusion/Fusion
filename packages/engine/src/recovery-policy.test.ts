import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeRecoveryDecision,
  formatDelay,
  MAX_RECOVERY_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  BACKOFF_MULTIPLIER,
} from "./recovery-policy.js";

describe("computeRecoveryDecision", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns shouldRetry=true on first failure (count=0)", () => {
    const decision = computeRecoveryDecision({});
    expect(decision.shouldRetry).toBe(true);
    expect(decision.exhausted).toBe(false);
    expect(decision.nextState.recoveryRetryCount).toBe(1);
    expect(decision.nextState.nextRecoveryAt).toBeDefined();
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it("increments recovery count on each attempt", () => {
    const d1 = computeRecoveryDecision({ recoveryRetryCount: 0 });
    expect(d1.nextState.recoveryRetryCount).toBe(1);

    const d2 = computeRecoveryDecision({ recoveryRetryCount: 1 });
    expect(d2.nextState.recoveryRetryCount).toBe(2);

    const d3 = computeRecoveryDecision({ recoveryRetryCount: 2 });
    expect(d3.nextState.recoveryRetryCount).toBe(3);
  });

  it("exhausts after MAX_RECOVERY_RETRIES attempts", () => {
    const decision = computeRecoveryDecision({
      recoveryRetryCount: MAX_RECOVERY_RETRIES,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.exhausted).toBe(true);
    expect(decision.nextState.recoveryRetryCount).toBeUndefined();
    expect(decision.nextState.nextRecoveryAt).toBeUndefined();
    expect(decision.delayMs).toBe(0);
  });

  it("also exhausts when count exceeds max (overflow safety)", () => {
    const decision = computeRecoveryDecision({
      recoveryRetryCount: 999,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.exhausted).toBe(true);
  });

  it("uses exponential backoff with increasing delays", () => {
    // Use fixed random for deterministic test
    vi.spyOn(Math, "random").mockReturnValue(0.5); // No jitter when random=0.5

    const d1 = computeRecoveryDecision({});
    const d2 = computeRecoveryDecision({ recoveryRetryCount: 1 });
    const d3 = computeRecoveryDecision({ recoveryRetryCount: 2 });

    // Base: 60s, then 120s, then 240s (capped at 300s)
    expect(d1.delayMs).toBe(BASE_DELAY_MS); // 60s × 2^0 = 60s
    expect(d2.delayMs).toBe(BASE_DELAY_MS * BACKOFF_MULTIPLIER); // 60s × 2^1 = 120s
    expect(d3.delayMs).toBe(BASE_DELAY_MS * BACKOFF_MULTIPLIER ** 2); // 60s × 2^2 = 240s
  });

  it("caps delay at MAX_DELAY_MS", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    // With high retry count, delay should be capped
    const decision = computeRecoveryDecision({ recoveryRetryCount: 2 });
    expect(decision.delayMs).toBeLessThanOrEqual(MAX_DELAY_MS * 1.1); // Allow for jitter
  });

  it("applies jitter (±10%) to delays", () => {
    // Zero jitter
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const noJitter = computeRecoveryDecision({});

    // Max positive jitter
    vi.spyOn(Math, "random").mockReturnValue(1.0);
    const maxJitter = computeRecoveryDecision({});

    // Max negative jitter
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    const minJitter = computeRecoveryDecision({});

    // All should be within ±10% of base delay
    const base = BASE_DELAY_MS;
    expect(noJitter.delayMs).toBe(base);
    expect(maxJitter.delayMs).toBeGreaterThan(base);
    expect(maxJitter.delayMs).toBeLessThanOrEqual(base * 1.1);
    expect(minJitter.delayMs).toBeLessThan(base);
    expect(minJitter.delayMs).toBeGreaterThanOrEqual(base * 0.9);
  });

  it("sets nextRecoveryAt to a future ISO timestamp", () => {
    const before = Date.now();
    const decision = computeRecoveryDecision({});
    const after = Date.now();

    const recoveryTime = new Date(decision.nextState.nextRecoveryAt!).getTime();
    expect(recoveryTime).toBeGreaterThanOrEqual(before + decision.delayMs - 1);
    expect(recoveryTime).toBeLessThanOrEqual(after + decision.delayMs + 1);
  });

  it("treats undefined recoveryRetryCount as 0", () => {
    const decision = computeRecoveryDecision({ recoveryRetryCount: undefined });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextState.recoveryRetryCount).toBe(1);
  });

  it("clears recovery metadata when exhausted", () => {
    const decision = computeRecoveryDecision({
      recoveryRetryCount: MAX_RECOVERY_RETRIES,
      nextRecoveryAt: new Date().toISOString(),
    });
    expect(decision.nextState.recoveryRetryCount).toBeUndefined();
    expect(decision.nextState.nextRecoveryAt).toBeUndefined();
  });
});

describe("formatDelay", () => {
  it("formats seconds under 60 as Ns", () => {
    expect(formatDelay(5000)).toBe("5s");
    expect(formatDelay(30000)).toBe("30s");
    expect(formatDelay(59000)).toBe("59s");
  });

  it("formats exact minutes as Nm", () => {
    expect(formatDelay(60000)).toBe("1m");
    expect(formatDelay(120000)).toBe("2m");
    expect(formatDelay(300000)).toBe("5m");
  });

  it("formats non-exact minutes as seconds", () => {
    expect(formatDelay(90000)).toBe("90s");
    expect(formatDelay(150000)).toBe("150s");
  });

  it("handles zero", () => {
    expect(formatDelay(0)).toBe("0s");
  });
});

describe("constants", () => {
  it("MAX_RECOVERY_RETRIES is 3", () => {
    expect(MAX_RECOVERY_RETRIES).toBe(3);
  });

  it("BASE_DELAY_MS is 60 seconds", () => {
    expect(BASE_DELAY_MS).toBe(60_000);
  });

  it("MAX_DELAY_MS is 300 seconds (5 minutes)", () => {
    expect(MAX_DELAY_MS).toBe(300_000);
  });
});
