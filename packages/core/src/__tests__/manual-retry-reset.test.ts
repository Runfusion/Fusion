import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  MANUAL_RETRY_RESET_COUNTER_KEYS,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
} from "../manual-retry-reset.js";

const RETRY_SUMMARY_COUNTER_REGEX = /toCount\(task\.(\w+)\)/g;

describe("buildAutoPauseClearPatch", () => {
  it("clears the deadlock auto-pause for auto-paused tasks", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({
      paused: false,
      pausedReason: null,
    });
  });

  it("does not clear an explicit user pause", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: true,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({});
  });

  it("does not clear unrelated automatic pause reasons", () => {
    expect(buildAutoPauseClearPatch({
      paused: true,
      userPaused: undefined,
      pausedReason: "branch-conflict-unrecoverable",
    })).toEqual({});
  });

  it("is a no-op when the task is not paused", () => {
    expect(buildAutoPauseClearPatch({
      paused: undefined,
      userPaused: undefined,
      pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    })).toEqual({});
  });
});

describe("buildManualRetryResetPatch", () => {
  it("resets all manual retry counters to zero", () => {
    const patch = buildManualRetryResetPatch();

    for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
      expect(patch[key]).toBe(0);
    }
    expect(patch.graphResumeRetryCount).toBe(0);
    expect(patch.consecutiveToolFailureRetryCount).toBe(0);
    expect(patch.toolFailureDetectorLogCursor).toBeNull();
    expect(patch.toolFailureRetryExhaustedAuditEmitted).toBe(false);
  });

  it("includes all retry-summary counters in the reset key list", () => {
    const retrySummarySource = readFileSync(new URL("../retry-summary.ts", import.meta.url), "utf-8");
    const retrySummaryKeys = new Set<string>();
    let match: RegExpExecArray | null = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    while (match) {
      retrySummaryKeys.add(match[1]);
      match = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    }

    for (const key of retrySummaryKeys) {
      expect(MANUAL_RETRY_RESET_COUNTER_KEYS).toContain(key);
    }
  });

  it("sets mergeRetries only when requested", () => {
    expect(buildManualRetryResetPatch()).not.toHaveProperty("mergeRetries");
    expect(buildManualRetryResetPatch({ resetMergeRetries: true })).toMatchObject({ mergeRetries: 0 });
  });

  it("clears nextRecoveryAt", () => {
    expect(buildManualRetryResetPatch()).toMatchObject({ nextRecoveryAt: null });
  });
});
