import { describe, it, expect } from "vitest";
import {
  deriveCliTabVisibility,
  type CliSessionSummaryRecord,
} from "../TaskDetailModal";

function session(
  agentState: CliSessionSummaryRecord["agentState"],
): CliSessionSummaryRecord {
  return {
    id: "cli-1",
    taskId: "FN-1",
    projectId: "p1",
    adapterId: "claude-local",
    agentState,
    terminationReason: null,
    autonomyPosture: null,
  };
}

describe("TaskDetailModal terminal-tab visibility matrix (U11)", () => {
  it("no recorded session → tab hidden", () => {
    expect(deriveCliTabVisibility(null)).toEqual({ kind: "hidden" });
  });

  it("starting / busy / waitingOnInput → live terminal", () => {
    for (const s of ["starting", "ready", "busy", "waitingOnInput"] as const) {
      const v = deriveCliTabVisibility(session(s));
      expect(v.kind).toBe("live");
      if (v.kind === "live") {
        expect(v.mode).toBe("live");
        expect(v.readOnly).toBe(false);
      }
    }
  });

  it("one-shot (planning/validator) live → read-only live terminal", () => {
    const v = deriveCliTabVisibility(session("busy"), { oneShot: true });
    expect(v.kind).toBe("live");
    if (v.kind === "live") expect(v.readOnly).toBe(true);
  });

  it("generic-tier idle → confirm-advance strip offered on the live terminal", () => {
    const v = deriveCliTabVisibility(session("busy"), { genericIdle: true });
    expect(v.kind).toBe("live");
    if (v.kind === "live") expect(v.showConfirmAdvance).toBe(true);
  });

  it("execute-done resumable → replay 'session idle'", () => {
    expect(deriveCliTabVisibility(session("done"))).toEqual({
      kind: "replay",
      mode: "idle",
    });
  });

  it("reaped (dead / needsAttention) → replay 'session ended'", () => {
    expect(deriveCliTabVisibility(session("dead"))).toEqual({
      kind: "replay",
      mode: "ended",
    });
    expect(deriveCliTabVisibility(session("needsAttention"))).toEqual({
      kind: "replay",
      mode: "ended",
    });
  });
});
