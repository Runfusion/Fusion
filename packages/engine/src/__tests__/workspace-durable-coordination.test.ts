import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLeaseHandle } from "@fusion/core";
import { ensureTenancyFenceRef, mergeDispatchFenceRef } from "../merge/workspace-fence-ref.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

/*
FNXC:WorkspaceMergeDispatch 2026-08-15-09:46:
A dispatch tenancy is global to a workspace task while its protected resources live in separate
sub-repo remotes. Reentry must retain one durable pin and publish that same pin to each remote,
not assume a workspace root checkout has an origin that can fence all subsequent land pushes.
*/
describeIfGit("workspace durable dispatch coordination", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("publishes a reentrant dispatch pin to a second remote without rotating the tenancy", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    for (const repoRel of fx.repos) {
      const remote = `${fx.rootDir}/${repoRel}.git`;
      fx.git(repoRel, `git init --bare ${remote}`);
      fx.git(repoRel, `git remote add origin ${remote}`);
      fx.git(repoRel, "git push -u origin main");
    }
    const initial: WorkspaceLeaseHandle = {
      leaseKey: "merge-dispatch:FN-9059", kind: "merge-dispatch",
      owner: { taskId: "FN-9059", nodeId: "node-a", incarnationId: "inc-a" }, fenceToken: 7n,
    };
    const record = vi.fn(async (input: { handle: WorkspaceLeaseHandle; fenceRefName: string; fenceRefSha: string }) => ({
      ...input.handle, fenceRefName: input.fenceRefName, fenceRefSha: input.fenceRefSha,
    }));
    const fenceRefName = mergeDispatchFenceRef("FN-9059");
    const first = await ensureTenancyFenceRef({
      store: { recordWorkspaceLeaseFenceRef: record }, handle: initial, claimOutcome: "acquired",
      remote: "origin", cwd: fx.repoPath("repo-a"), fenceRefName,
    });
    const reentrant = await ensureTenancyFenceRef({
      store: { recordWorkspaceLeaseFenceRef: record }, handle: first, claimOutcome: "reentrant",
      remote: "origin", cwd: fx.repoPath("repo-b"), fenceRefName,
    });

    expect(record).toHaveBeenCalledOnce();
    expect(reentrant).toEqual(first);
    for (const repoRel of fx.repos) {
      expect(fx.git(repoRel, `git ls-remote origin ${fenceRefName}`).split(/\s+/)[0]).toBe(first.fenceRefSha);
    }
  });
});
