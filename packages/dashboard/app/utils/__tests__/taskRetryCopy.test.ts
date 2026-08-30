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
  });
});
