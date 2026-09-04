import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { hasGit } from "./_pipeline-git-fixture.js";
import { PipelineSmokeHarness } from "./_pipeline-harness.js";

const describeIfReady = hasGit ? pgDescribe : describe.skip;

/*
FNXC:PipelineSmoke 2026-08-24-15:40:
Multi-repository coverage. The single-repo lane structurally cannot reach this shape: there the
project root and the repository are the same directory, so a node resolving the root as a worktree
still works by accident. In a workspace the root is a plain container of per-repository checkouts
with no Git metadata, and that difference is what broke production — a write-capable review gate
declared no session boundary, the single-repo assertion resolved the container as a worktree, and
the gate died with "Refusing to start coding agent in incomplete worktree" before producing a
verdict. Both the topology tests and the mono-repo lane stayed green throughout.
*/
describeIfReady("pipeline smoke: multi-repository workspace", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_workspace",
    projectId: "pipeline-smoke-workspace",
  });
  let harness: PipelineSmokeHarness;

  beforeAll(pg.beforeAll);
  beforeEach(async () => {
    await pg.beforeEach();
    harness = await PipelineSmokeHarness.create(pg, { workspace: true });
  });
  afterEach(async () => {
    await harness.dispose();
    await pg.afterEach();
  });
  afterAll(pg.afterAll);

  it("builds a workspace project whose root is not a repository", async () => {
    expect(harness.fixture.repos).toEqual(["repo1", "repo2"]);
    expect(harness.fixture.integrationRepoDir).not.toBe(harness.fixture.repoDir);
    expect(harness.fixture.integrationRepoDir.startsWith(harness.fixture.repoDir)).toBe(true);
    expect(await harness.integrationSha()).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("drives a workspace task through the review-column gates to a merge", async () => {
    const task = await harness.createPipelineTask("builtin:coding-ideas-v2", {
      idPrefix: "WS",
      initialColumn: "hold",
      repositoryScope: ["repo1"],
    });
    const result = await harness.driveToDeclaredTerminal(task.id, "merged-done");
    expect(result.observedTerminal).toBe("merged-done");
    expect(result.wedge).toBeUndefined();

    /*
    The per-repository branch is the merge input for a workspace row; a task-level `branch` is
    legitimately absent. Assert the scoped repository actually recorded one, because handing the
    merger an empty ref is precisely how this path failed.
    */
    const live = await harness.store.getTask(task.id);
    expect(live.workspaceWorktrees?.repo1?.branch).toMatch(/^fusion\//);
    expect(live.mergeDetails?.mergeConfirmed).toBe(true);
  });

  it("merges the MULT-040 shape after Code Review publishes evidence for both modified repositories", async () => {
    const task = await harness.createPipelineTask("builtin:coding-ideas-v2", {
      idPrefix: "WS-BOTH",
      initialColumn: "hold",
      repositoryScope: ["repo1", "repo2"],
    });

    const result = await harness.driveToDeclaredTerminal(task.id, "merged-done", {
      commitImplementationInEveryWorkspaceRepository: true,
    });

    expect(result.observedTerminal).toBe("merged-done");
    expect(result.wedge).toBeUndefined();
    const live = await harness.store.getTask(task.id);
    expect(live.workspaceWorktrees?.repo1?.branch).toMatch(/^fusion\//);
    expect(live.workspaceWorktrees?.repo2?.branch).toMatch(/^fusion\//);
    expect(live.repositoryScope?.reviewEvidence).toEqual(expect.objectContaining({
      repo1: expect.objectContaining({ fingerprint: expect.any(String), approvedAt: expect.any(String) }),
      repo2: expect.objectContaining({ fingerprint: expect.any(String), approvedAt: expect.any(String) }),
    }));
    expect(live.mergeDetails?.mergeConfirmed).toBe(true);
  });
});
