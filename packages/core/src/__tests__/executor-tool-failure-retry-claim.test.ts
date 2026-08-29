import { describe, expect, it } from "vitest";
import {
  claimNextToolFailureRetryImpl,
  markToolFailureRetryExhaustedAuditImpl,
} from "../task-store/branch-and-pr-entities.js";

describe("executor tool-failure retry compatibility backend (FN-7996)", () => {
  it("preserves legacy terminal parking when no PostgreSQL claim store is available", async () => {
    // FNXC:ExecutorToolFailureRetry 2026-07-16-13:30: the removed SQLite runtime must not throw from the default-enabled retry policy.
    const compatibilityStore = { backendMode: false };

    await expect(claimNextToolFailureRetryImpl(compatibilityStore as never, "FN-7996", 12, 2))
      .resolves.toEqual({ outcome: "exhausted" });
    await expect(markToolFailureRetryExhaustedAuditImpl(compatibilityStore as never, "FN-7996"))
      .resolves.toBe(false);
  });
});
