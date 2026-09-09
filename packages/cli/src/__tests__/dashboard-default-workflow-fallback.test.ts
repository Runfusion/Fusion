/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
THE TUI'S NO-SELECTION FALLBACK WAS THE LEGACY WORKFLOW, so it rendered a lane the board does not have.

`packages/cli/src/commands/dashboard.ts` resolved a task's columns as `def?.ir ?? BUILTIN_CODING_WORKFLOW_IR`
and its card-chip fields the same way. That constant is the LEGACY monolithic IR
(`builtin:legacy-coding`); the catalog's actual default is `resolveDefaultWorkflowIr()`. Post-U11 they
differ, and the difference is a whole column:

    default  todo, in-progress, in-review, done          (planning merged into todo)
    legacy   triage, todo, in-progress, in-review, done

So a task with no workflow selection row was rendered against a five-column board including `triage`,
which the real default no longer declares.

This is the same drift `builtin-workflows.ts` records as ALREADY FIXED for the move-path resolvers —
`prepareWorkflowMovePolicyPreflightImpl` went through the catalog while `resolveTaskWorkflowIrForMove`
used the raw constant, and a no-selection task produced two different workflow signatures ("workflow
move policy preflight is stale"). Both were routed through the shared helper so the default could not
drift again. This surface was missed.

WHAT THIS TEST CAN AND CANNOT DO, stated because the honest scope is narrow. Driving the TUI board
end-to-end needs a rendered terminal and a live store; that harness does not exist here and building
one to assert a fallback would be testing the harness. So this pins the two facts that make the bug
possible and the fix meaningful:

  1. the two IRs genuinely disagree, and disagree about `triage` specifically — if a future change
     re-merges them this test says so, and the fix becomes unnecessary rather than silently wrong;
  2. the TUI source no longer reaches for the legacy constant as a fallback.

(2) is a source assertion, which is weaker than driving the code. It is used here for the same reason
the FloatingWindow aria-label scan uses one: the defect is a VALUE at a call site, there is no single
render that reaches it, and a per-site render test would pin the one site someone bothered to write.
*/

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_CODING_WORKFLOW_IR, resolveDefaultWorkflowIr } from "@fusion/core";

const DASHBOARD_SRC = resolve(fileURLToPath(import.meta.url), "../../commands/dashboard.ts");

function columnIds(ir: unknown): string[] {
  const v2 = ir as { version?: string; columns?: Array<{ id: string }> };
  return v2.version === "v2" ? (v2.columns ?? []).map((c) => c.id) : [];
}

/** Comment-stripped, so prose naming the constant is not read as a call site. */
function dashboardCode(): string {
  return readFileSync(DASHBOARD_SRC, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

describe("the TUI's no-selection workflow fallback", () => {
  it("the catalog default and the legacy constant genuinely disagree", () => {
    const def = columnIds(resolveDefaultWorkflowIr());
    const legacy = columnIds(BUILTIN_CODING_WORKFLOW_IR);

    /* Anti-vacuity: both must actually resolve to v2 column sets, or the comparison below is
       comparing two empty arrays and passes for the wrong reason. */
    expect(def.length).toBeGreaterThan(0);
    expect(legacy.length).toBeGreaterThan(0);

    expect(legacy).toContain("triage");
    expect(def).not.toContain("triage");
  });

  it("dashboard.ts does not fall back to the legacy constant", () => {
    /* The bug was `def?.ir ?? BUILTIN_CODING_WORKFLOW_IR` in two places — board columns and card
       chip fields. Asserting absence rather than a specific call shape, because the next spelling of
       the same mistake will not look like the last one. */
    expect(dashboardCode()).not.toContain("BUILTIN_CODING_WORKFLOW_IR");
    expect(dashboardCode()).toContain("resolveDefaultWorkflowIr");
  });
});
