import { describe, expect, it, vi } from "vitest";
import { withRateLimitRetry } from "../rate-limit-retry.js";

const limited = () => new Error("429 quota exceeded");

describe("withRateLimitRetry rotation", () => {
  it("retries immediately when a rotation supplies a different instance", async () => {
    const nextInstance = vi.fn().mockResolvedValueOnce({ providerId: "anthropic", instanceId: "backup" });
    let calls = 0;
    await expect(withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw limited();
      return "ok";
    }, { rotation: { providerId: "anthropic", nextInstance }, baseDelayMs: 0 })).resolves.toBe("ok");
    expect(calls).toBe(2);
    expect(nextInstance).toHaveBeenCalledTimes(1);
  });

  it("does not use candidateCount as a rotation cap", async () => {
    const nextInstance = vi.fn()
      .mockResolvedValueOnce({ providerId: "anthropic", instanceId: "b" })
      .mockResolvedValueOnce({ providerId: "anthropic", instanceId: "c" });
    let calls = 0;
    await expect(withRateLimitRetry(async () => {
      calls++;
      if (calls < 3) throw limited();
      return "ok";
    }, { rotation: { providerId: "anthropic", candidateCount: 0, nextInstance }, baseDelayMs: 0 })).resolves.toBe("ok");
    expect(nextInstance).toHaveBeenCalledTimes(2);
  });

  it("does not invoke rotation for non-limit, transient auth, or aborted work", async () => {
    const nextInstance = vi.fn();
    await expect(withRateLimitRetry(async () => { throw new Error("network 500"); }, { rotation: { providerId: "anthropic", nextInstance } })).rejects.toThrow("network 500");
    await expect(withRateLimitRetry(async () => { throw new Error("401 authentication_error token expired"); }, { rotation: { providerId: "anthropic", nextInstance }, maxRetries: 0 })).rejects.toThrow("401");
    const abort = new AbortController(); abort.abort();
    await expect(withRateLimitRetry(async () => { throw limited(); }, { rotation: { providerId: "anthropic", nextInstance }, signal: abort.signal })).rejects.toThrow("429");
    expect(nextInstance).not.toHaveBeenCalled();
  });

  it("treats an undefined rotation exactly as the existing retry path", async () => {
    const calls: number[] = [];
    const operation = () => { calls.push(1); return Promise.reject(limited()); };
    await expect(withRateLimitRetry(operation, { maxRetries: 0 })).rejects.toThrow("429");
    const baselineCalls = calls.length;
    calls.length = 0;
    await expect(withRateLimitRetry(operation, { maxRetries: 0, rotation: { providerId: "anthropic", nextInstance: async () => undefined } })).rejects.toThrow("429");
    expect(calls).toHaveLength(baselineCalls);
  });
});
