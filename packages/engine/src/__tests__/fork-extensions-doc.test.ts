import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const readmePath = resolve(workspaceRoot, "README.md");
const forkDocPath = resolve(workspaceRoot, "docs", "fork-extensions.md");
const migrationsDir = resolve(workspaceRoot, "packages", "core", "src", "postgres", "migrations");

/*
FNXC:ForkExtensionsDoc 2026-10-05-01:25:
docs/fork-extensions.md is the single record of which capabilities belong to this build rather than
to upstream Runfusion/Fusion, and README links it from the hero section. Upstream's own migration
`0085_drop_excluded_upstream_feature_schema.sql` names this build as the full-featured one and lists
the slots it never implements (0074, 0076, 0079-0083), so the boundary is upstream-authored, not a
claim we invented. A README claim that outlives its code is worse than no claim, so this guard
asserts the observable facts behind the table: each capability's anchor file still exists and still
carries the identifier the table cites, upstream's relocation migration never appears here (we are
the build it moves features *out of*), and our own schema slots stay present. Deleting a capability
without updating the doc now fails CI.

Deliberate scope limit: nothing here asserts documentation prose, headings, or date stamps — only
link integrity and code constructs. The doc's "deliberately not claimed" list cannot be guarded from
this repository because it makes a statement about `origin/main`, which a test run does not fetch.
*/

const CLAIMED_CAPABILITIES: Array<{ capability: string; anchor: string; file: string }> = [
  { capability: "human plan-approval gate", anchor: "humanPlanApproval", file: "packages/core/src/planner/human-plan-approval.ts" },
  { capability: "human merge-approval gate", anchor: "humanMergeApproval", file: "packages/core/src/merge/human-merge-approval.ts" },
  { capability: "project notes", anchor: "AsyncNoteStore", file: "packages/core/src/async-stores/async-note-store.ts" },
  { capability: "whiteboards", anchor: "AsyncWhiteboardStore", file: "packages/core/src/async-stores/async-whiteboard-store.ts" },
  { capability: "per-turn memory recall", anchor: "perTurnRecall", file: "packages/core/src/memory/recall/per-turn-recall.ts" },
  { capability: "operator language directive", anchor: "operatorLanguage", file: "packages/core/src/config/operator-language.ts" },
  { capability: "review-lane dispatch sweep", anchor: "ReviewDispatchSweep", file: "packages/engine/src/scheduling/review-dispatch-sweep.ts" },
  { capability: "verification resource envelope", anchor: "applyVerificationResourceBound", file: "packages/engine/src/execution/verification-resource-bound.ts" },
  { capability: "chat liveness reconciliation", anchor: "classifyChatInFlightLiveness", file: "packages/core/src/chat/chat-liveness.ts" },
];

/** Migration slots upstream's 0085 comment states their published binary never implements. */
const SLOTS_WE_CARRY = [
  "0074_fn_323_project_notes.sql",
  "0076_fn_333_whiteboards.sql",
  "0079_fn_393_workflow_identity_and_project_model_lanes.sql",
  "0080_fn_408_task_human_plan_approval.sql",
  "0083_fn_514_task_human_merge_approval.sql",
  "0091_stas_205_review_lane_ledger.sql",
] as const;

describe("docs/fork-extensions.md", () => {
  it("exists so the README link resolves", () => {
    expect(existsSync(forkDocPath), "docs/fork-extensions.md must exist while README links it").toBe(true);
  });

  it("is linked from the root README", () => {
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).toContain("docs/fork-extensions.md");
  });

  it.each(CLAIMED_CAPABILITIES)("$capability is still implemented by $file", ({ anchor, file }) => {
    const path = resolve(workspaceRoot, file);
    expect(existsSync(path), `${file} backs a capability claimed in docs/fork-extensions.md`).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain(anchor);
  });

  it("does not carry upstream's excluded-feature relocation migration", () => {
    const relocated = `${migrationsDir}/0085_drop_excluded_upstream_feature_schema.sql`;
    expect(
      existsSync(relocated),
      "this build is the full-featured one 0085 moves features out of; it must not ship that migration",
    ).toBe(false);
  });

  it.each(SLOTS_WE_CARRY)("carries our own schema slot %s", (migration) => {
    expect(existsSync(resolve(migrationsDir, migration)), `${migration} is a fork-owned schema slot`).toBe(true);
  });
});
