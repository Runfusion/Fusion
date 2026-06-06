import { describe, it, expect } from "vitest";
import {
  shouldAutoMergeTask,
  type AutoMergeRoute,
  type ReviewerVerdictStatus,
} from "../auto-merge-gate.js";

/**
 * U7 chokepoint matrix. The predicate is pure: it takes resolved facts and
 * returns a routing decision. The engine wrapper (auto-merge-gate-engine.ts)
 * binds the stores; here we exercise the routing logic directly.
 */

function route(input: {
  global: boolean;
  override: boolean | undefined;
  prMode?: boolean;
  isCompanyBoard?: boolean;
  verdictStatus?: ReviewerVerdictStatus;
  hasManualApprovalMarker?: boolean;
}): AutoMergeRoute {
  return shouldAutoMergeTask({
    task: { autoMerge: input.override },
    settings: { autoMerge: input.global },
    prMode: input.prMode ?? false,
    isCompanyBoard: input.isCompanyBoard ?? false,
    verdictStatus: input.verdictStatus,
    hasManualApprovalMarker: input.hasManualApprovalMarker,
  }).route;
}

describe("shouldAutoMergeTask — 24-cell matrix (flag-on company coding board)", () => {
  // global {on,off} × override {unset,true,false} × verdict {pass,fail,pending,manual-approved}
  const globals = [true, false] as const;
  const overrides = [undefined, true, false] as const;
  const verdicts: Array<{ verdictStatus?: ReviewerVerdictStatus; manual?: boolean; label: string }> = [
    { verdictStatus: "pass", label: "pass" },
    { verdictStatus: "fail", label: "fail" },
    { verdictStatus: "pending", label: "pending" },
    { verdictStatus: "pass", manual: true, label: "manual-approved" },
  ];

  // Expected route per cell. Company board, non-PR (coding auto-merge board).
  // Precedence in the predicate:
  //   1. additive processing (global×override) — fail → manual-required
  //   2. manual-approval marker → manual-required
  //   3. company verdict (pass required) — else blocked
  //   4. route by merge mode → auto-enqueue
  function expected(global: boolean, override: boolean | undefined, v: typeof verdicts[number]): AutoMergeRoute {
    // 1a. explicit per-task disable → manual-required (even global-on)
    if (override === false) return "manual-required";
    // 1b. global off without an explicit true → manual-required
    if (global === false && override !== true) return "manual-required";
    // 2. manual-approval marker
    if (v.manual) return "manual-required";
    // 3. company verdict gate
    if (v.verdictStatus !== "pass") return "blocked";
    // 4. coding auto-merge board
    return "auto-enqueue";
  }

  for (const global of globals) {
    for (const override of overrides) {
      for (const v of verdicts) {
        const exp = expected(global, override, v);
        it(`global=${global} override=${String(override)} verdict=${v.label} → ${exp}`, () => {
          expect(
            route({
              global,
              override,
              isCompanyBoard: true,
              verdictStatus: v.verdictStatus,
              hasManualApprovalMarker: v.manual,
            }),
          ).toBe(exp);
        });
      }
    }
  }

  it("the matrix has 24 cells", () => {
    expect(globals.length * overrides.length * verdicts.length).toBe(24);
  });
});

describe("shouldAutoMergeTask — PR-mode guard", () => {
  it("routes pr-subgraph regardless of global setting when processing-eligible + verdict passes", () => {
    // global on (override unset) and global off (explicit override true) both process.
    expect(route({ global: true, override: undefined, prMode: true, isCompanyBoard: true, verdictStatus: "pass" })).toBe("pr-subgraph");
    expect(route({ global: true, override: true, prMode: true, isCompanyBoard: true, verdictStatus: "pass" })).toBe("pr-subgraph");
    expect(route({ global: false, override: true, prMode: true, isCompanyBoard: true, verdictStatus: "pass" })).toBe("pr-subgraph");
  });

  it("PR-mode still blocks on a pending verdict (verdict-driven on company boards)", () => {
    expect(
      route({ global: true, override: undefined, prMode: true, isCompanyBoard: true, verdictStatus: "pending" }),
    ).toBe("blocked");
  });

  it("PR-mode + explicit per-task disable → manual-required (additive gate first)", () => {
    expect(
      route({ global: true, override: false, prMode: true, isCompanyBoard: true, verdictStatus: "pass" }),
    ).toBe("manual-required");
  });

  it("PR-mode on a NON-company board (flag-off) still routes pr-subgraph, verdict never consulted", () => {
    expect(
      route({ global: true, override: undefined, prMode: true, isCompanyBoard: false, verdictStatus: undefined }),
    ).toBe("pr-subgraph");
  });
});

describe("shouldAutoMergeTask — manual-approval marker", () => {
  it("explicit marker → manual-required, never auto, even with a passing verdict", () => {
    expect(
      route({ global: true, override: undefined, isCompanyBoard: true, verdictStatus: "pass", hasManualApprovalMarker: true }),
    ).toBe("manual-required");
  });

  it("marker → manual-required even on a non-company auto-merge board", () => {
    expect(
      route({ global: true, override: undefined, isCompanyBoard: false, hasManualApprovalMarker: true }),
    ).toBe("manual-required");
  });
});

describe("shouldAutoMergeTask — flag off / non-company degrades to global×override only", () => {
  // Verdict is NEVER consulted here — a legacy board has no verdict.
  it("global on, override unset → auto-enqueue (verdict ignored)", () => {
    expect(route({ global: true, override: undefined, isCompanyBoard: false, verdictStatus: "fail" })).toBe("auto-enqueue");
  });

  it("global on, override false → manual-required (preserves manual-required parking)", () => {
    expect(route({ global: true, override: false, isCompanyBoard: false })).toBe("manual-required");
  });

  it("global off, override true → auto-enqueue (the override path)", () => {
    expect(route({ global: false, override: true, isCompanyBoard: false })).toBe("auto-enqueue");
  });

  it("global off, override unset → manual-required", () => {
    expect(route({ global: false, override: undefined, isCompanyBoard: false })).toBe("manual-required");
  });

  it("global off, override false → manual-required", () => {
    expect(route({ global: false, override: false, isCompanyBoard: false })).toBe("manual-required");
  });

  it("matches allowsAutoMergeProcessing for the four legacy cells (additive, not resolved)", () => {
    // global ON → always processes (manual-required for false, auto for the rest)
    expect(route({ global: true, override: undefined, isCompanyBoard: false })).toBe("auto-enqueue");
    expect(route({ global: true, override: true, isCompanyBoard: false })).toBe("auto-enqueue");
    // global OFF → only explicit true processes
    expect(route({ global: false, override: true, isCompanyBoard: false })).toBe("auto-enqueue");
    expect(route({ global: false, override: undefined, isCompanyBoard: false })).toBe("manual-required");
  });
});

describe("shouldAutoMergeTask — reasons are populated", () => {
  it("every route carries a non-empty reason", () => {
    const cases = [
      route({ global: true, override: undefined, isCompanyBoard: true, verdictStatus: "pass" }),
      route({ global: true, override: undefined, isCompanyBoard: true, verdictStatus: "pending" }),
      route({ global: true, override: false, isCompanyBoard: true, verdictStatus: "pass" }),
      route({ global: true, override: undefined, prMode: true, isCompanyBoard: true, verdictStatus: "pass" }),
    ];
    expect(new Set(cases)).toEqual(new Set(["auto-enqueue", "blocked", "manual-required", "pr-subgraph"]));
    const result = shouldAutoMergeTask({
      task: { autoMerge: undefined },
      settings: { autoMerge: true },
      prMode: false,
      isCompanyBoard: true,
      verdictStatus: "pending",
    });
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
