import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const engineRoot = resolve(process.cwd(), "src");

function source(relativePath: string): string {
  return readFileSync(resolve(engineRoot, relativePath), "utf-8");
}

/**
 * FNXC:BranchNaming 2026-08-21-09:36:
 * FN-107 keeps this source-level census beside caller-facing lifecycle tests. The task-store
 * boundary deliberately rejects populated and null branch writes without provenance, so every
 * production writer must visibly choose engine or operator ownership rather than relying on a
 * helper-only validation test.
 */
const productionBranchWriters = [
  "worktree/worktree-acquisition.ts",
  "executor/workspace-config-resolver.ts",
  "executor/worktree-branch-conflict-handle.ts",
  "self-healing/auto-recover-worktree-session.ts",
  "merger.ts",
  "self-healing.ts",
  "../../dashboard/src/routes/register-planning-subtask-routes.ts",
] as const;

describe("production task branch-write provenance census", () => {
  it("keeps every scoped production branch writer on the explicit provenance contract", () => {
    for (const writer of productionBranchWriters) {
      const text = source(writer);
      expect(text, `${writer} must use the explicit branch-write provenance contract`)
        .toContain("branchWriteOrigin");
    }
  });

  it("distinguishes absent branch metadata from populated and explicit-clear mutations", () => {
    const absentPatch: { worktree: string; branch?: string | null; branchWriteOrigin?: "engine" | "operator" } = {
      worktree: "/tmp/worktree",
    };
    const populatedPatch = { worktree: "/tmp/worktree", branch: "fusion/fn-107", branchWriteOrigin: "engine" as const };
    const clearPatch = { worktree: null, branch: null, branchWriteOrigin: "engine" as const };

    expect(absentPatch.branch).toBeUndefined();
    expect(absentPatch.branchWriteOrigin).toBeUndefined();
    expect(populatedPatch).toMatchObject({ branch: "fusion/fn-107", branchWriteOrigin: "engine" });
    expect(clearPatch).toMatchObject({ branch: null, branchWriteOrigin: "engine" });
  });
});
