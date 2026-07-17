import { describe, expect, it } from "vitest";
import { evaluateCompletedPromotionFailureProvenance, type TaskLogEntry } from "../index.js";

/**
 * FNXC:Lifecycle 2026-07-16-10:30:
 * FN-8141 invariant: a stranded-completed promotion candidate whose MOST RECENT execution-outcome
 * in the durable task log was a failure/refusal park must be blocked; a failure superseded by a
 * newer clean completion, or a task with zero failure markers, must not be blocked.
 */

let seq = 0;
function entry(action: string): TaskLogEntry {
  // Monotonic timestamps keep log order deterministic without relying on Date.now().
  seq += 1;
  return { timestamp: `2026-07-16T10:00:${String(seq).padStart(2, "0")}.000Z`, action };
}

function log(actions: string[]): TaskLogEntry[] {
  return actions.map(entry);
}

const FAILURE_PARK = "FN-8141: task parked failed during no-fn_task_done retry — honoring park, not retrying";
const REFUSAL_EXHAUST = "bulk-step-completion-without-review — fn_task_done refusal retry budget exhausted";
const CLEAN_DONE = "Task marked done by agent";
const IMPLICIT_DONE = "All steps complete — implicit fn_task_done (agent did not call tool explicitly)";

describe("evaluateCompletedPromotionFailureProvenance", () => {
  it("blocks when the tail failure marker is the FN-8141 park", () => {
    const result = evaluateCompletedPromotionFailureProvenance({
      log: log([
        "Starting execution",
        IMPLICIT_DONE,
        REFUSAL_EXHAUST,
        FAILURE_PARK,
        // pause-abort bounce to todo (not an execution-outcome marker)
        "Execution paused — session preserved for resume, moved to todo",
      ]),
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("failure-provenance");
    expect(result.markerAction).toContain("task parked failed during no-fn_task_done retry");
  });

  it("blocks on the refusal-budget-exhaust marker even without the terminal park line", () => {
    const result = evaluateCompletedPromotionFailureProvenance({
      log: log([IMPLICIT_DONE, REFUSAL_EXHAUST]),
    });
    expect(result).toMatchObject({ blocked: true, reason: "failure-provenance" });
  });

  it("blocks on the retry-budget and implicit-refusal failure variants", () => {
    expect(
      evaluateCompletedPromotionFailureProvenance({
        log: log(["boom — execution failed after task-done retry budget was exhausted"]),
      }).blocked,
    ).toBe(true);
    expect(
      evaluateCompletedPromotionFailureProvenance({
        log: log(["nope — execution failed because implicit fn_task_done was refused"]),
      }).blocked,
    ).toBe(true);
  });

  it("does NOT block when a fresh clean completion supersedes an earlier failure park", () => {
    const result = evaluateCompletedPromotionFailureProvenance({
      log: log([
        REFUSAL_EXHAUST,
        FAILURE_PARK,
        "Execution paused — session preserved for resume, moved to todo",
        // operator retried → fresh execution completed all steps cleanly
        "Resuming execution after unpause",
        CLEAN_DONE,
      ]),
    });
    expect(result).toEqual({ blocked: false });
  });

  it("does NOT block when the clean completion is the implicit-done variant", () => {
    const result = evaluateCompletedPromotionFailureProvenance({
      log: log([FAILURE_PARK, IMPLICIT_DONE]),
    });
    expect(result).toEqual({ blocked: false });
  });

  it("does NOT block a task with zero failure markers", () => {
    expect(
      evaluateCompletedPromotionFailureProvenance({
        log: log(["Starting execution", CLEAN_DONE]),
      }),
    ).toEqual({ blocked: false });
  });

  it("does NOT block an empty or missing log", () => {
    expect(evaluateCompletedPromotionFailureProvenance({ log: [] })).toEqual({ blocked: false });
    expect(
      evaluateCompletedPromotionFailureProvenance({ log: undefined as unknown as TaskLogEntry[] }),
    ).toEqual({ blocked: false });
  });

  it("treats the MOST RECENT outcome as authoritative regardless of earlier markers", () => {
    // failure → clean → failure again: the tail failure wins.
    expect(
      evaluateCompletedPromotionFailureProvenance({
        log: log([FAILURE_PARK, CLEAN_DONE, REFUSAL_EXHAUST]),
      }).blocked,
    ).toBe(true);
    // clean → failure → clean: the tail clean wins.
    expect(
      evaluateCompletedPromotionFailureProvenance({
        log: log([CLEAN_DONE, REFUSAL_EXHAUST, CLEAN_DONE]),
      }).blocked,
    ).toBe(false);
  });

  it("bounds the scan to the tail: an ancient failure beyond the window is not reached", () => {
    // One failure marker followed by >250 benign, non-outcome entries: the scan window never
    // reaches the failure, so no failure provenance is detected (not blocked).
    const ancientFailure = [FAILURE_PARK, ...Array.from({ length: 300 }, (_v, i) => `heartbeat ${i}`)];
    expect(evaluateCompletedPromotionFailureProvenance({ log: log(ancientFailure) }).blocked).toBe(false);
  });
});
