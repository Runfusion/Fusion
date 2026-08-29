// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSquashOverlapsFileScope, FileScopeViolationError } from "../../merger.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { makeReliabilityFixture, hasGit, hasPg, git } from "./_helpers.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;

describeIfGit("reliability interactions: workflow + file-scope", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];

  afterEach(async () => {
    while (fixtures.length) {
      await fixtures.pop()!.cleanup();
    }
  });

  it("sanity: makeReliabilityFixture builds a real git repo", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-SANITY" });
    fixtures.push(fx);
    await fx.writeAndCommit("src/sanity.txt", "ok\n", "feat: sanity");
    expect(git(fx.rootDir, "git rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(fx.rootDir, "git rev-parse HEAD").length).toBe(40);
  });

  it("Case 1: off-scope staged change trips FileScopeViolationError", async () => {
    const fx = await makeReliabilityFixture({
      taskId: "FN-4361-C1",
      task: { scopeOverride: false },
    });
    fixtures.push(fx);

    vi.spyOn(fx.store, "parseFileScopeFromPrompt").mockResolvedValue(["packages/engine/src/**"]);
    await mkdir(join(fx.rootDir, "packages/core/src"), { recursive: true });
    await writeFile(join(fx.rootDir, "packages/core/src/offscope.txt"), "x\n", "utf-8");
    git(fx.rootDir, "git add packages/core/src/offscope.txt");

    await expect(assertSquashOverlapsFileScope({
      store: fx.store,
      rootDir: fx.rootDir,
      taskId: fx.task.id,
      task: await fx.store.getTask(fx.task.id) as any,
    })).rejects.toBeInstanceOf(FileScopeViolationError);
  });

  it("Case 10: scopeOverride bypasses file-scope invariant", async () => {
    const fx = await makeReliabilityFixture({
      taskId: "FN-4361-C10",
      task: { scopeOverride: true, scopeOverrideReason: "interaction-test" },
    });
    fixtures.push(fx);
    vi.spyOn(fx.store, "parseFileScopeFromPrompt").mockResolvedValue(["packages/engine/src/**"]);
    await mkdir(join(fx.rootDir, "packages/core/src"), { recursive: true });
    await writeFile(join(fx.rootDir, "packages/core/src/offscope-override.txt"), "x\n", "utf-8");
    git(fx.rootDir, "git add packages/core/src/offscope-override.txt");

    await expect(assertSquashOverlapsFileScope({
      store: fx.store,
      rootDir: fx.rootDir,
      taskId: fx.task.id,
      task: await fx.store.getTask(fx.task.id) as any,
    })).resolves.toBeUndefined();
  });

  it("Case 11: workflow ordering remains enabledWorkflowSteps order (script first)", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-C11" });
    fixtures.push(fx);

    await fx.store.updateTask(fx.task.id, {
      enabledWorkflowSteps: ["WS-SCRIPT", "WS-PROMPT"],
      workflowStepResults: [
        { workflowStepId: "WS-SCRIPT", workflowStepName: "script", phase: "pre-merge", status: "failed", output: "script failed" },
      ],
    } as any);

    const task = await fx.store.getTask(fx.task.id);
    expect(task?.enabledWorkflowSteps).toEqual(["WS-SCRIPT", "WS-PROMPT"]);
    expect(task?.workflowStepResults?.[0]?.workflowStepId).toBe("WS-SCRIPT");
    expect(task?.workflowStepResults?.[0]?.status).toBe("failed");
  });
});
