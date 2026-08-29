import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DOC_PATH = resolve(__dirname, "../../../../docs/workflow-policy-ownership-map.md");

const REQUIRED_SOURCE_FILES = [
  "packages/engine/src/project-engine.ts",
  "packages/engine/src/scheduler.ts",
  "packages/engine/src/self-healing.ts",
  "packages/engine/src/merger.ts",
  "packages/engine/src/merger-ai.ts",
  "packages/engine/src/merger-integration-worktree.ts",
  "packages/engine/src/group-merge-coordinator.ts",
  "packages/engine/src/transient-merge-error-classifier.ts",
  "packages/engine/src/retry-with-backoff.ts",
  "packages/engine/src/rate-limit-retry.ts",
  "packages/core/src/store.ts",
  "packages/core/src/task-merge.ts",
  "packages/core/src/retry-summary.ts",
  "packages/core/src/manual-retry-reset.ts",
  "packages/core/src/builtin-coding-workflow-ir.ts",
  "packages/core/src/builtin-stepwise-coding-workflow-ir.ts",
  "packages/core/src/builtin-pr-workflow-ir.ts",
  "packages/dashboard/app/components/TaskCard.tsx",
] as const;

const REQUIRED_POLICY_SURFACES = [
  "Auto-merge queue enqueue and dequeue",
  "Merge checkout, integration, conflict resolution, squash, finalize",
  "Branch-group member integration and group promotion",
  "Dependency satisfaction treats `in-review` as satisfied",
  "Active scope leases include unmerged `in-review` worktrees",
  "Manual retry reset",
  "Recover mergeable in-review tasks",
  "Completion handoff limbo recovery",
  "Transient merge failure recovery",
  "Already-landed and no-op finalization",
  "Built-in default workflow definitions",
  "Dashboard task-card merge/retry/stall badges",
] as const;

describe("workflow policy ownership map", () => {
  const doc = readFileSync(DOC_PATH, "utf-8");

  it("classifies every required policy surface from the workflow-owned merge plan", () => {
    for (const surface of REQUIRED_POLICY_SURFACES) {
      expect(doc, `missing ownership surface: ${surface}`).toContain(surface);
    }
  });

  it("anchors the map to the production source files that own merge, retry, scheduling, and projection today", () => {
    for (const file of REQUIRED_SOURCE_FILES) {
      expect(doc, `missing source file: ${file}`).toContain(file);
    }
  });

  it("records the migration dispositions needed for later deletion gates", () => {
    for (const disposition of [
      "`substrate`",
      "`workflow-policy`",
      "`capability`",
      "`compat-projection`",
      "`delete-after-cutover`",
    ]) {
      expect(doc).toContain(disposition);
    }

    expect(doc).toContain("## Deletion Gates");
    expect(doc).toContain("No production caller may start checkout, branch integration, squash, or finalize");
    expect(doc).toContain("Task-level retry and merge fields are compatibility summaries");
  });
});
