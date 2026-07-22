// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it } from "vitest";
import { checkDiffVolume } from "../../merge/merger-diff-volume-gate.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { makeReliabilityFixture, hasGit, hasPg, git } from "./_helpers.js";

const describeIfGit = hasGit && hasPg ? describe : describe.skip;

describeIfGit("reliability interactions: merge strategy + overlap", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];
  afterEach(async () => { while (fixtures.length) await fixtures.pop()!.cleanup(); });

  // Case 6 (auto-strategy multi-commit history) is covered by src/__tests__/merger-commit-strategy.real-git.test.ts: auto-routes multi-substantive branches to history-preserving direct merge.

  it("Case 7: diff-volume gate detects dropped branch contribution", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-C7" });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-c7");
    await fx.writeAndCommit("packages/core/src/drop.ts", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n", "feat: branch volume");
    await fx.checkout("main");
    const base = git(fx.rootDir, "git rev-parse HEAD");
    git(fx.rootDir, "git merge --squash fusion/fn-4361-c7");
    git(fx.rootDir, "git reset HEAD -- packages/core/src/drop.ts");

    await expect(checkDiffVolume({
      rootDir: fx.rootDir,
      branch: "fusion/fn-4361-c7",
      integrationTargetSha: base,
      minLines: 20,
      threshold: 0.2,
      allowlistGlobs: [],
      taskId: fx.task.id,
    })).rejects.toMatchObject({ name: "DiffVolumeRegressionError" });
  });

  it("Additional: diff-volume gate runs before later invariant checks on empty staged set", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-MX" });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-mx");
    await fx.writeAndCommit("src/mx.txt", Array.from({ length: 40 }, (_, i) => `x${i}`).join("\n") + "\n", "feat: mx");
    await fx.checkout("main");
    const base = git(fx.rootDir, "git rev-parse HEAD");
    git(fx.rootDir, "git merge --squash fusion/fn-4361-mx");
    git(fx.rootDir, "git reset HEAD -- src/mx.txt");
    await expect(checkDiffVolume({ rootDir: fx.rootDir, branch: "fusion/fn-4361-mx", integrationTargetSha: base, minLines: 20, threshold: 0.2, allowlistGlobs: [], taskId: fx.task.id })).rejects.toBeTruthy();
  });
});
