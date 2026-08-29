import { describe, it, expect } from "vitest";
import { deriveExecutorState } from "../hooks/useExecutorStats";

/*
FNXC:EngineControls 2026-07-24-18:35:
Regression cover for the pause-reads-as-idle bug: a paused engine with nothing
running rendered the same "Idle" footer badge as a healthy engine waiting for
work, so operators could not tell why triage/planning had stopped. The invariant
under test is pause-dominates-run-state across the whole matrix, not just the
reported zero-running repro — asserted at every running count and against both
pause flags, since globalPause must keep out-ranking enginePaused.
*/
describe("deriveExecutorState", () => {
  it("reports paused at every running count, including zero", () => {
    for (const runningTaskCount of [0, 1, 5]) {
      expect(deriveExecutorState(false, true, runningTaskCount)).toBe("paused");
    }
  });

  it("reports stopped whenever globalPause is set, outranking enginePaused", () => {
    for (const enginePaused of [false, true]) {
      for (const runningTaskCount of [0, 1, 5]) {
        expect(deriveExecutorState(true, enginePaused, runningTaskCount)).toBe("stopped");
      }
    }
  });

  it("reports idle only when unpaused with nothing running", () => {
    expect(deriveExecutorState(false, false, 0)).toBe("idle");
  });

  it("reports running when unpaused with work in flight", () => {
    expect(deriveExecutorState(false, false, 1)).toBe("running");
    expect(deriveExecutorState(false, false, 5)).toBe("running");
  });

  it("never reports idle while either pause flag is set", () => {
    for (const globalPause of [false, true]) {
      for (const enginePaused of [false, true]) {
        if (!globalPause && !enginePaused) continue;
        for (const runningTaskCount of [0, 1, 5]) {
          expect(deriveExecutorState(globalPause, enginePaused, runningTaskCount)).not.toBe("idle");
        }
      }
    }
  });
});
