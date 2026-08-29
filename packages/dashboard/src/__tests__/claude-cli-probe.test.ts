import { describe, expect, it } from "vitest";
import { probeClaudeCli } from "../claude-cli-probe.js";

/**
 * These tests exercise the real probe — we deliberately do NOT mock
 * `spawn`. The probe's job is to tell the truth about the local system,
 * and mocking defeats that. Instead we:
 *
 *   1. Assert the shape is sound regardless of binary availability
 *   2. Assert timeouts fire when the binary hangs (we don't have a
 *      hanging binary fixture, so we cover the structural case only)
 *   3. Let the suite pass whether or not `claude` is installed on the
 *      test runner — both outcomes are legitimate.
 *
 * If you need mocked probe behavior for a higher-level route test, spy
 * on `probeClaudeCli` at the import boundary rather than shimming spawn.
 */
describe("probeClaudeCli", () => {
  it("returns a well-formed result whether or not claude is installed", async () => {
    const result = await probeClaudeCli();
    expect(typeof result.available).toBe("boolean");
    expect(typeof result.probeDurationMs).toBe("number");
    if (result.available) {
      // When available: version string should come back populated.
      expect(typeof result.version).toBe("string");
    } else {
      // When unavailable: reason must be populated so the UI can render.
      expect(typeof result.reason).toBe("string");
    }
  });

  it("respects a short timeout", async () => {
    // Not a true hang test (we don't have a hanging binary), but
    // confirms the timeoutMs option wires through and probe completes
    // in a bounded window when using a very small timeout.
    const result = await probeClaudeCli({ timeoutMs: 50 });
    expect(result.probeDurationMs).toBeLessThan(5000);
    // Either it completed fast enough or hit the timeout — both fine.
    if (!result.available && result.reason?.includes("timed out")) {
      expect(result.reason).toContain("50ms");
    }
  });
});
