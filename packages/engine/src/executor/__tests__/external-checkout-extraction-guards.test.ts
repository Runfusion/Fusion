import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:CodeOrganization 2026-08-10-02:15:
The executor split must preserve external-checkout ownership fences that used to live in executor.ts.
*/
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

function readSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("executor extraction safety guards", () => {
  it("keeps operator-owned external checkouts outside managed worktree preflight and cleanup", () => {
    const source = readSource("packages/engine/src/executor/run-implementation.ts");

    expect(source).toMatch(
      /*
      FNXC:ExternalExecutionCheckout 2026-08-14-05:32:
      The guarded invariant is the STRUCTURE — base-SHA capture sits inside the
      `!workspaceConfig && !isResume` gate, and the external-execution gate follows it as the very
      next statement — plus the arguments the call must receive. It was previously written as one
      exact source line, so adding the run-attribution argument broke the guard without changing
      anything it protects. Whitespace between the arguments is now tolerated; the ordering, the two
      gate conditions, and their adjacency are still pinned.
      */
      /if \(!deps\.workspaceConfig && !acquisition\.isResume\) \{[\s\S]*?await captureBaseCommitSha\(\s*deps\.store,\s*task,\s*worktreePath,\s*audit,\s*\{ isResume: false \},[\s\S]*?\);\s*\}\s*if \(!deps\.workspaceConfig && !externalExecutionRoute\.configured\) \{/,
    );
    expect(source).toContain("if (!deps.workspaceConfig && !externalExecutionRoute.configured)");
    expect(
      source.match(/^\s*if \(!externalExecutionRoute\.configured && worktreePath && existsSync\(worktreePath\)\) \{/gm) ?? [],
    ).toHaveLength(5);
    expect(
      source.match(/^\s*if \(!externalExecutionRoute\.configured\) \{\n\s+await deps\.resetStepsIfWorkLost\(latestTask\);\n\s*\}/gm) ?? [],
    ).toHaveLength(2);
    expect(source).toMatch(
      /\} finally \{\n\s+\/\*\n\s+FNXC:ExternalExecutionCheckout 2026-08-10-03:13:\n\s+External checkouts remain operator-owned[\s\S]*?\n\s+\*\/\n\s+releaseExternalExecutionActiveWorktree\(/,
    );
    expect(source).toMatch(
      /releaseExternalExecutionActiveWorktree\(\n\s+deps\.activeWorktrees,\n\s+task\.id,\n\s+externalExecutionRoute\.configured,\n\s+\);\n\n\s+if \(reviewAddressingActivated\) \{[\s\S]*?deps\.executing\.delete\(task\.id\);\n\s+executingTaskLock\.release\(task\.id\);/,
    );
    expect(source).not.toMatch(/^\s*if \(worktreePath && existsSync\(worktreePath\)\) \{/m);
    expect(source.match(/^\s*await deps\.resetStepsIfWorkLost\(latestTask\);$/gm) ?? []).toHaveLength(2);
  });

  it("marks the injected graph-node worktree creator as native", () => {
    const source = readSource("packages/engine/src/executor/ensure-graph-custom-node-worktree.ts");

    expect(source).toContain('createWorktreeBackendKind: "native"');
  });
});
