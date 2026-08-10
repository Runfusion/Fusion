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
      /if \(!deps\.workspaceConfig && !acquisition\.isResume\) \{\n\s+await captureBaseCommitSha\(deps\.store, task, worktreePath, audit, \{ isResume: false \}\);\n\s+\}\n\n\s+if \(!deps\.workspaceConfig && !externalExecutionRoute\.configured\) \{/,
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
