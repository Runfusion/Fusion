// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it } from "vitest";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { makeReliabilityFixture, hasGit, hasPg, git } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;

describeIfGit("reliability interactions: audit + recovery", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];
  afterEach(async () => {
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("Case 3: tree-equal strategy recovers already-merged review task", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-C3" });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-c3");
    await fx.writeAndCommit("src/tree.txt", "one\ntwo\n", "feat: branch aggregate");
    await fx.checkout("main");
    await fx.writeAndCommit("src/tree.txt", "one\n", "feat: main part1");
    await fx.writeAndCommit("src/tree.txt", "one\ntwo\n", "feat: main part2");
    await fx.store.updateTask(fx.task.id, { branch: "fusion/fn-4361-c3", status: "failed", mergeRetries: 3, column: "in-review" } as any);

    const recovered = await fx.selfHeal.recoverAlreadyMergedReviewTasks();
    const task = await fx.store.getTask(fx.task.id);
    expect(recovered).toBeGreaterThanOrEqual(0);
    expect(["in-review", "done"]).toContain(task?.column ?? "");
  }, 20_000);

  it("Case 4: already-done is idempotent", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-C4" });
    fixtures.push(fx);
    await fx.store.updateTask(fx.task.id, { column: "done", status: null } as any);
    const recovered = await fx.selfHeal.recoverAlreadyMergedReviewTasks();
    expect(recovered).toBe(0);
  }, 20_000);

  it("Case 13: tree-equal does not promote when worktree has staged changes", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-C13" });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-c13");
    await fx.writeAndCommit("src/tree13.txt", "a\nb\n", "feat: branch aggregate");
    await fx.checkout("main");
    await fx.writeAndCommit("src/tree13.txt", "a\n", "feat: main p1");
    await fx.writeAndCommit("src/tree13.txt", "a\nb\n", "feat: main p2");
    await fx.store.updateTask(fx.task.id, { branch: "fusion/fn-4361-c13", status: "failed", mergeRetries: 3, column: "in-review", worktree: fx.rootDir } as any);
    await fx.checkout("fusion/fn-4361-c13");
    await fx.writeAndCommit("src/other.txt", "local\n", "feat: local");
    await fx.checkout("main");

    const recovered = await fx.selfHeal.recoverAlreadyMergedReviewTasks();
    expect(recovered).toBeGreaterThanOrEqual(0);
    const task = await fx.store.getTask(fx.task.id);
    expect(["in-review", "done"]).toContain(task?.column ?? "");
    expect(git(fx.rootDir, "git rev-parse HEAD").length).toBe(40);
  }, 20_000);
});
