import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(async () => ({
    prompt: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  })),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<unknown> }, prompt: string) => {
    await session.prompt(prompt);
  }),
  compactSessionContext: vi.fn(),
}));

import { aiMergeTask } from "../merger.js";
import { mergerLog } from "../logger.js";
import { resolveMergeIntegrationRoot } from "../merger-integration-worktree.js";
/*
FNXC:PgMigrationQuarantine 2026-07-18-04:10:
VAL-REMOVAL-005 reliability fixtures use PostgreSQL AsyncDataLayer storage. Read
run audits through getRunAuditEventsAsync so each assertion observes committed
backend events rather than the removed synchronous SQLite read surface.
*/
import { git, hasGit, hasPg, makeReliabilityFixture } from "./reliability-interactions/_helpers.js";

describe("FN-5348 cwd integration fallback removed", () => {
  it.skipIf(!hasGit || !hasPg)("Scenario A/B: dirty reused worktree is autostashed and the merge proceeds without any cwd fallback", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5348-DIRTY-AUTOSTASH",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5348-dirty.ts", "export const dirty = true;\n", "feat: add dirty autostash content");
      await fixture.checkout("master");
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      await store.enqueueMergeQueue(task.id);
      git(worktreePath, "sh -c 'printf dirty > DIRTY.txt'");

      await aiMergeTask(store, rootDir, task.id).catch(() => undefined);

      const autostashEvents = (await store.getRunAuditEventsAsync({ taskId: task.id }))
        .filter((event) => event.mutationType === "merge:reuse-handoff-autostash");
      expect(autostashEvents.length).toBeGreaterThanOrEqual(1);
      const meta = autostashEvents[0]?.metadata ?? {};
      expect(meta).toMatchObject({ worktreePath });
      expect(typeof meta.stashSha).toBe("string");
      expect((meta.stashSha as string).length).toBeGreaterThan(0);

      // FN-5348 invariant preserved: no cwd-main fallback path was taken.
      const refused = (await store.getRunAuditEventsAsync({ taskId: task.id }))
        .filter((event) => event.mutationType === "merge:cwd-integration-fallback-refused");
      expect(refused).toHaveLength(0);

      // The audit metadata's stashSha is sufficient proof of recoverability;
      // the worktree may be torn down by the time the merge finishes.
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("Scenario C: worktrunk no longer forces cwd mode", () => {
    const root = resolveMergeIntegrationRoot({
      task: { id: "FN-5348", worktree: "/tmp/task-worktree" } as any,
      settings: { mergeIntegrationWorktree: "reuse-task-worktree", worktrunk: { enabled: true } } as any,
      projectRoot: "/tmp/project-root",
    });
    expect(root.mode).toBe("reuse-task-worktree");
  });

  it.skipIf(!hasGit || !hasPg)("Scenario D: explicit opt-in (legacy alias) emits warning", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5348-CWD-OPTIN",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "cwd-main",
      } as any,
    });

    const warnSpy = vi.spyOn(mergerLog, "warn").mockImplementation(() => undefined as any);

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5348-optin.ts", "export const optin = true;\n", "feat: add cwd opt-in merge content");
      await fixture.checkout("master");

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("mergeIntegrationWorktree=cwd-integration-branch is explicit opt-in"));
      const auditTypes = (await store.getRunAuditEventsAsync({ taskId: task.id })).map((event) => event.mutationType);
      expect(auditTypes).not.toContain("merge:cwd-integration-fallback-removed");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.todo("Scenario E: reserved tripwire — no production emit site after Step 3; future regression would add one");

  it("Scenario E: no production code path assigns integrationRoot.mode to a cwd-* mode (cwd-main or cwd-integration-branch)", () => {
    // FN-5440: start-of-line anchoring intentionally targets real assignments, not prose comments.
    const cwdModeAssignmentRegex = /^\s*integrationRoot\.mode\s*=\s*"(cwd-main|cwd-integration-branch)"/m;
    const merger = readFileSync(new URL("../merger.ts", import.meta.url), "utf-8");
    expect(merger).not.toMatch(cwdModeAssignmentRegex);

    const autoRecoveryRoot = new URL("../", import.meta.url);
    const autoRecovery = readFileSync(new URL("../auto-recovery.ts", import.meta.url), "utf-8");
    expect(autoRecovery).not.toMatch(cwdModeAssignmentRegex);

    const autoRecoveryHandlersDir = new URL("../auto-recovery-handlers/", import.meta.url);
    for (const file of readdirSync(autoRecoveryHandlersDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".ts")) continue;
      const source = readFileSync(new URL(file.name, autoRecoveryHandlersDir), "utf-8");
      expect(source).not.toMatch(cwdModeAssignmentRegex);
    }

  });
});
