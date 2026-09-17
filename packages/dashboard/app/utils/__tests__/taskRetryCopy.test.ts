import { describe, expect, it } from "vitest";
import { resolveRetryStageCopy } from "../taskRetryCopy";

const t = (_key: string, fallback: string) => fallback;

describe("resolveRetryStageCopy", () => {
  it.each([
    [{ intake: true }, "plan"],
    [{ hold: true }, "plan"],
    [{ countsTowardWip: true }, "implementation"],
    [{ mergeBlocker: true }, "review"],
    [{ humanReview: true }, "review"],
  ] as const)("resolves %o as %s", (flags, stage) => {
    expect(resolveRetryStageCopy(t as never, flags, "custom").stage).toBe(stage);
  });

  it("gives review precedence over WIP and WIP precedence over planning", () => {
    expect(resolveRetryStageCopy(t as never, { mergeBlocker: true, countsTowardWip: true, hold: true }, "combined").stage).toBe("review");
    expect(resolveRetryStageCopy(t as never, { countsTowardWip: true, intake: true }, "combined").stage).toBe("implementation");
  });

  it("uses generic copy before workflow metadata resolves", () => {
    const copy = resolveRetryStageCopy(t as never, undefined, "triage");
    expect(copy.stage).toBe("generic");
    expect(copy.confirmMessage).toContain("current column");
    expect(copy.preserveWorkAvailable).toBe(false);
  });

  /*
  FNXC:ColumnRestart 2026-09-17-09:16:
  FN-499: the preserve-work checkbox is offered by the WIP stage only; every other stage, and the
  unresolved first-paint state, must keep today's plain confirmation.
  */
  it.each([
    [{ intake: true }, false],
    [{ hold: true }, false],
    [{ countsTowardWip: true }, true],
    [{ mergeBlocker: true }, false],
    [{ humanReview: true }, false],
    [undefined, false],
  ] as const)("offers preserve-work for %o: %s", (flags, available) => {
    const copy = resolveRetryStageCopy(t as never, flags, "custom");
    expect(copy.preserveWorkAvailable).toBe(available);
    expect(copy.preserveWorkLabel.length).toBeGreaterThan(0);
    expect(copy.preserveWorkDescription.length).toBeGreaterThan(0);
    expect(copy.preservedSuccessMessage.length).toBeGreaterThan(0);
  });
});
