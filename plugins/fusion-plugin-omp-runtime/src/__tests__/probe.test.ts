import { describe, expect, it } from "vitest";
import { probeOmpBinary } from "../probe.js";

describe("probeOmpBinary", () => {
  it("tries configured path first, then PATH fallback", async () => {
    const missing = "/nonexistent/omp-binary-that-does-not-exist";
    const status = await probeOmpBinary({
      binaryPath: missing,
      timeoutMs: 500,
    });
    expect(status.configuredBinaryPath).toBe(missing);
    expect(status.probeDurationMs).toBeGreaterThanOrEqual(0);
    // Diagnostics should mention the configured path failure even if PATH omp succeeds.
    expect(status.diagnostics?.some((d) => d.includes("nonexistent"))).toBe(true);

    if (status.available) {
      // Machine has `omp` on PATH — fallback is intentional (mirrors Grok probe).
      expect(status.usingConfiguredBinaryPath).toBe(false);
      expect(status.authenticated).toBe(true);
    } else {
      expect(status.authenticated).toBe(false);
      expect(status.reason).toMatch(/failed|not found/i);
    }
  });
});
