import { describe, expect, it } from "vitest";
import { Scheduler } from "../scheduler.js";

/**
 * RUFU-823 — a forced-open scheduling guard has to name the board and the leg.
 *
 * The production watchdog emitted `previous pass still marked in-flight after 600s — forcing the guard
 * open so dispatch resumes` 66 times in one three-hour window. With ~20 project schedulers in one
 * process that sentence cannot be attributed to a single board, and it cannot say which leg of
 * `schedule()` the pass was inside, so the stall was countable but not diagnosable — the same gap
 * RUFU-372 closed for capacity refusals. These tests pin the two fields the sentence must carry.
 *
 * The phase is asserted through `describeStuckPass`, the seam that renders the operator-facing
 * sentence, so a later edit that drops a field from the log call fails here rather than silently.
 */

type StuckDescriber = { describeStuckPass(stuckMs: number): string };

function schedulerAtLeg(phase: string, rootDir = "/boards/runfusion"): StuckDescriber {
  /*
  The renderer is reached on the prototype with a synthetic `this` instead of a constructed Scheduler:
  the constructor subscribes to store events, so a constructed instance would make this test depend on
  an event emitter it does not need. The method reads only `store.getRootDir()` and `schedulingPhase`,
  and those are exactly the two values under test.
  */
  const render = (Scheduler.prototype as unknown as StuckDescriber).describeStuckPass;
  const self = { store: { getRootDir: () => rootDir }, schedulingPhase: phase };
  return { describeStuckPass: (stuckMs: number) => render.call(self, stuckMs) };
}

describe("stuck scheduling pass warning is attributable", () => {
  it("names which project's board is stuck", () => {
    const line = schedulerAtLeg("hold-release-sweep", "/boards/saneca").describeStuckPass(601_000);
    expect(line).toContain("project=/boards/saneca");
  });

  it("names the leg the pass reached instead of only that something stalled", () => {
    const line = schedulerAtLeg("hold-release-sweep").describeStuckPass(600_000);
    expect(line).toContain("leg=hold-release-sweep");
    expect(line).toContain("600s");
  });

  it("reports the leg it actually reached, not a fixed label", () => {
    expect(schedulerAtLeg("board-read").describeStuckPass(900_000)).toContain("leg=board-read");
    expect(schedulerAtLeg("mission-symbol-locks").describeStuckPass(900_000)).toContain(
      "leg=mission-symbol-locks",
    );
    expect(schedulerAtLeg("post-sweep-reread").describeStuckPass(900_000)).toContain(
      "leg=post-sweep-reread",
    );
    expect(schedulerAtLeg("advisory-reporters").describeStuckPass(900_000)).toContain(
      "leg=advisory-reporters",
    );
  });

  it("says idle when the guard was set before any leg ran", () => {
    expect(schedulerAtLeg("idle").describeStuckPass(600_000)).toContain("leg=idle");
  });

  it("keeps the force-open promise the original sentence made", () => {
    expect(schedulerAtLeg("board-read").describeStuckPass(600_000)).toContain(
      "forcing the guard open so dispatch resumes",
    );
  });
});
