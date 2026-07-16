import { describe, expect, it, vi } from "vitest";
import {
  buildPlanVerifiedMessage,
  buildReviewRollbackFailureMessage,
  buildReviewUnavailableMessage,
  buildReviewVerdictMessage,
  buildStepFailureMessage,
  buildStepSkippedMessage,
  buildStepStartMessage,
  buildStepSuccessMessage,
  emitProactiveStatus,
  sanitizeFailureReason,
} from "../proactive-status.js";

describe("proactive status narration", () => {
  it("sanitizes nullish, stack, path, token and multiline diagnostics", () => {
    const raw = "Error: token=super-secret\n at run (/Users/a/project/file.ts:1:2)\nBearer abcdefghijklmnopqrstuvwxyz\n" + "output\n".repeat(200);
    const safe = sanitizeFailureReason(raw);
    expect(safe).toContain("[REDACTED]");
    expect(safe).not.toContain("/Users/a");
    expect(safe).not.toContain("\n");
    expect(safe.length).toBeLessThanOrEqual(300);
    expect(sanitizeFailureReason(undefined)).toBe("No failure reason was provided.");
    expect(sanitizeFailureReason(null)).toBe("No failure reason was provided.");
    expect(sanitizeFailureReason({ toString: () => { throw new Error("nope"); } })).toBe("No failure reason was provided.");
  });

  it("elides absolute paths outside the common home-directory roots", () => {
    const safe = sanitizeFailureReason("Command failed reading /etc/fusion/secrets.env from /srv/fusion/current/config.yaml");
    expect(safe).toBe("Command failed reading [path] from [path]");
    expect(safe).not.toContain("/etc/");
    expect(safe).not.toContain("/srv/");
  });

  it("builds complete status messages and safely reports unavailable reviews", () => {
    expect(buildStepStartMessage(2, "Ship it")).toBe("Starting Step 2: Ship it");
    expect(buildStepSuccessMessage(2, "Ship it")).toBe("Step 2 finished — Ship it.");
    expect(buildStepSkippedMessage(2, "No code change needed")).toBe("Step 2 was skipped — No code change needed.");
    expect(buildStepSkippedMessage(2, "Step 2")).toBe("Step 2 was skipped.");
    expect(buildStepFailureMessage(2, "Ship it", sanitizeFailureReason(undefined))).toContain("No failure reason");
    expect(buildPlanVerifiedMessage()).toBe("The plan was written and verified.");
    expect(buildReviewVerdictMessage("UNAVAILABLE", "nope")).toBeNull();
    expect(buildReviewUnavailableMessage("token=secret /etc/fusion/secrets.env")).toBe("Review could not complete: token=[REDACTED] [path]");
    expect(buildReviewVerdictMessage("RETHINK", "token=secret /home/private/file")).toMatch(/\[REDACTED\]/);
    expect(buildReviewRollbackFailureMessage(sanitizeFailureReason("/Users/me/private.ts"))).toBe("Review could not roll the step back: [path]");
  });

  it("persists status narration best-effort", async () => {
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);
    await emitProactiveStatus({ appendAgentLog } as never, "FN-1", "Finished", "executor", "safe detail");
    expect(appendAgentLog).toHaveBeenCalledWith("FN-1", "Finished", "status", "safe detail", "executor");
    await expect(emitProactiveStatus({ appendAgentLog: vi.fn().mockRejectedValue(new Error("down")) } as never, "FN-1", "Finished", "reviewer")).resolves.toBeUndefined();
  });
});
