import { describe, expect, it } from "vitest";
import type { InReviewStallCode, Task } from "@fusion/core";
import { findInReviewStallLogEntry } from "../utils/findInReviewStallLogEntry";
import { getInReviewStallDeadlockCopy } from "../utils/inReviewStallCopy";
import { getTaskLogEntryAction, getTaskLogEntryOutcome } from "../utils/taskLogEntryDisplay";

describe("task log entry display helpers", () => {
  it("falls back to text/detail for legacy or operator-shaped log entries", () => {
    const entry = {
      timestamp: "2026-06-14T18:50:17Z",
      text: "Operator parked incomplete stuck-loop-exhausted task",
      detail: "Backups preserved before recovery",
      type: "operator",
    };

    expect(getTaskLogEntryAction(entry)).toBe("Operator parked incomplete stuck-loop-exhausted task");
    expect(getTaskLogEntryOutcome(entry)).toBe("Backups preserved before recovery");
  });

  it("returns safe empty display values for malformed entries", () => {
    expect(getTaskLogEntryAction({ timestamp: "now" })).toBe("");
    expect(getTaskLogEntryOutcome({ timestamp: "now" })).toBeUndefined();
    expect(getTaskLogEntryAction(undefined)).toBe("");
  });

  it("falls back from blank action/outcome strings to legacy fields", () => {
    const entry = {
      timestamp: "2026-06-14T18:50:17Z",
      action: "   ",
      outcome: "",
      text: "Legacy action text",
      detail: "Legacy detail text",
    };

    expect(getTaskLogEntryAction(entry)).toBe("Legacy action text");
    expect(getTaskLogEntryOutcome(entry)).toBe("Legacy detail text");
  });

  it("does not throw while scanning logs that contain entries without action", () => {
    const task = {
      log: [
        { timestamp: "2026-06-14T18:50:17Z", text: "operator note", type: "operator" },
        { timestamp: "2026-06-14T18:51:17Z", action: "In-review stall surfaced [merge-retries-exhausted]" },
      ],
    } as unknown as Pick<Task, "log">;

    const code: InReviewStallCode = "merge-retries-exhausted";
    expect(findInReviewStallLogEntry(task, code)?.reversedIndex).toBe(0);
  });

  it("does not throw while checking deadlock copy logs that contain entries without action", () => {
    const task = {
      pausedReason: undefined,
      log: [
        { timestamp: "2026-06-14T18:50:17Z", text: "operator note", type: "operator" },
        { timestamp: "2026-06-14T18:51:17Z", action: "In-review stall auto-disposed [merge-blocker]" },
      ],
    } as unknown as Pick<Task, "pausedReason" | "log">;

    expect(getInReviewStallDeadlockCopy(task)?.headline).toBe("In-review deadlock auto-disposed");
  });
});
