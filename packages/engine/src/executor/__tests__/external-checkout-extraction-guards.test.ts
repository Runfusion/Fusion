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

    expect(source).toContain("if (!deps.workspaceConfig && !externalExecutionRoute.configured)");
    expect(
      source.match(/^\s*if \(!externalExecutionRoute\.configured && worktreePath && existsSync\(worktreePath\)\) \{/gm),
    ).toHaveLength(5);
    expect(
      source.match(/^\s*if \(!externalExecutionRoute\.configured\) \{\n\s+await deps\.resetStepsIfWorkLost\(latestTask\);\n\s*\}/gm),
    ).toHaveLength(2);
    expect(source).not.toMatch(/^\s*if \(worktreePath && existsSync\(worktreePath\)\) \{/m);
    expect(source.match(/^\s*await deps\.resetStepsIfWorkLost\(latestTask\);$/gm)).toHaveLength(2);
  });

  it("marks the injected graph-node worktree creator as native", () => {
    const source = readSource("packages/engine/src/executor/ensure-graph-custom-node-worktree.ts");

    expect(source).toContain('createWorktreeBackendKind: "native"');
  });
});
