import { describe, expect, it } from "vitest";
import { decideAutoPrerebase } from "../../merge/merger-auto-prerebase.js";

describe("auto-prerebase reliability interactions", () => {
  it("defers when worktrunk is enabled", () => {
    const decision = decideAutoPrerebase({
      settings: { prerebaseAutoEnabled: true, prerebaseHotFiles: ["AGENTS.md"], prerebaseDivergenceThreshold: 50 } as any,
      baseCommitSha: "abc",
      commitsBehind: 100,
      changedFiles: ["AGENTS.md"],
      worktrunkEnabled: true,
    });
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("worktrunk-deferred");
  });

  it("hot-file trigger has precedence over threshold and remains compatible with smart-prefer-main strategy", () => {
    const decision = decideAutoPrerebase({
      settings: { prerebaseAutoEnabled: true, prerebaseHotFiles: ["packages/engine/src/merger.ts"], prerebaseDivergenceThreshold: 1 } as any,
      baseCommitSha: "abc",
      commitsBehind: 999,
      changedFiles: ["packages/engine/src/merger.ts"],
      worktrunkEnabled: false,
    });
    expect(decision.reason).toBe("hot-file");
    expect(decision.fire).toBe(true);
  });

  it("no-divergence path preserves already-on-main/fast-path behavior", () => {
    const decision = decideAutoPrerebase({
      settings: { prerebaseAutoEnabled: true, prerebaseHotFiles: ["AGENTS.md"], prerebaseDivergenceThreshold: 50 } as any,
      baseCommitSha: "abc",
      commitsBehind: 0,
      changedFiles: [],
      worktrunkEnabled: false,
    });
    expect(decision.reason).toBe("no-divergence");
  });
});
