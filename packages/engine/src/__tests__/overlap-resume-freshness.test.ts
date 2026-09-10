import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlapResumeSynchronizationError, synchronizeOverlapWaitBeforeExecution } from "../executor/overlap-resume-gate.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion-overlap-freshness-"));
  roots.push(root);
  git(root, "init", "-q"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test");
  await writeFile(join(root, "shared.ts"), "export function sharedApi(a: string) {}\n");
  git(root, "add", "."); git(root, "commit", "-qm", "c0");
  const c0 = git(root, "rev-parse", "HEAD");
  const baseBranch = git(root, "branch", "--show-current");
  git(root, "checkout", "-qb", "waiting");
  git(root, "checkout", "-q", baseBranch);
  await writeFile(join(root, "shared.ts"), "export function sharedApi(a: number) {}\n");
  git(root, "commit", "-qam", "holder delivery");
  const c1 = git(root, "rev-parse", "HEAD");
  const waitingPath = `${root}-waiting`;
  roots.push(waitingPath);
  git(root, "worktree", "add", "-q", waitingPath, "waiting");
  return { root, waitingPath, c0, c1 };
}
function store(c1: string, pending = true, durableProof = false) {
  let revision = 1;
  return {
    listTaskOverlapWaits: vi.fn(async () => pending ? [{ taskId: "FN-B", episodeId: "episode-1", blockerTaskId: "FN-A", phase: "observed", revision, attempt: 0, ...(durableProof ? { observation: { deliveries: [{ blockerTaskId: "FN-A", repository: ".", landedSha: c1, summary: "Changed shared API", evidence: "merge-details" }] } } : {}) }] : []),
    getTask: vi.fn(async (id: string) => id === "FN-B"
      ? task
      : { id: "FN-A", summary: "Changed shared API", mergeDetails: { commitSha: c1, landedFiles: ["shared.ts"] } }),
    claimTaskOverlapWait: vi.fn(async (claim) => ({ taskId: "FN-B", episodeId: "episode-1", blockerTaskId: "FN-A", phase: "analyzing", revision: ++revision, attempt: 1, owner: claim.owner })),
    completeTaskOverlapWait: vi.fn(async (input) => ({ taskId: "FN-B", episodeId: "episode-1", blockerTaskId: "FN-A", phase: input.phase, revision: ++revision, attempt: 1, owner: input.owner, receipt: input.receipt })),
  } as any;
}
const task = { id: "FN-B", prompt: "## Mission\nUse `sharedApi`.\n\n## File Scope\n- `shared.ts`\n\n## Steps\n", modifiedFiles: [], declaredSymbols: ["sharedApi"], lineageId: "lineage-b" } as any;

afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("overlap resume freshness gate", () => {
  it("refreshes a clean stale checkout and proves the delivered commit before authorization", async () => {
    const fx = await fixture();
    const mock = store(fx.c1);
    const result = await synchronizeOverlapWaitBeforeExecution({
      task, store: mock, worktreePath: fx.waitingPath, owner: "owner-1",
      refresh: async () => { git(fx.waitingPath, "merge", "--ff-only", fx.c1); },
    });
    expect(git(fx.waitingPath, "merge-base", "--is-ancestor", fx.c1, "HEAD") || "included").toBe("included");
    expect(await readFile(join(fx.waitingPath, "shared.ts"), "utf8")).toContain("number");
    expect(result.analysis?.decision).toBe("revalidate");
    expect(mock.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ phase: "revalidation-pending" }));
  });

  it("uses the durable delivery snapshot after the blocker row is deleted and recaptures its files", async () => {
    const fx = await fixture();
    const mock = store(fx.c1, true, true);
    mock.getTask.mockImplementation(async (id: string) => id === "FN-B" ? task : Promise.reject(new Error("blocker deleted")));
    const result = await synchronizeOverlapWaitBeforeExecution({
      task, store: mock, worktreePath: fx.waitingPath, owner: "owner-after-restart",
      refresh: async () => { git(fx.waitingPath, "merge", "--ff-only", fx.c1); },
    });
    expect(mock.getTask).not.toHaveBeenCalledWith("FN-A");
    expect(result.analysis?.deliveries[0]).toMatchObject({ landedSha: fx.c1, evidence: "git-recapture", paths: [expect.objectContaining({ path: "shared.ts" })] });
  });

  it("preserves every byte of a dirty stale checkout and refuses ordinary work", async () => {
    const fx = await fixture();
    await writeFile(join(fx.waitingPath, "local.txt"), "keep me exactly\n");
    const mock = store(fx.c1);
    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: mock, worktreePath: fx.waitingPath, owner: "owner-1" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "stale-dirty-worktree" } satisfies Partial<OverlapResumeSynchronizationError>);
    expect(await readFile(join(fx.waitingPath, "local.txt"), "utf8")).toBe("keep me exactly\n");
    expect(git(fx.waitingPath, "rev-parse", "HEAD")).toBe(fx.c0);
  });

  it("does not authorize a workspace episode until every repository is fresh", async () => {
    const fx = await fixture();
    let episode: any = {
      taskId: "FN-B", episodeId: "workspace-episode", blockerTaskId: "FN-A", phase: "observed", revision: 1, attempt: 0,
      observation: { deliveries: [
        { blockerTaskId: "FN-A", repository: "repo-a", landedSha: fx.c0, paths: [], evidence: "workspace-landing" },
        { blockerTaskId: "FN-A", repository: "repo-b", landedSha: fx.c1, paths: [{ repository: "repo-b", path: "shared.ts", status: "modified" }], evidence: "workspace-landing" },
      ] },
    };
    const workspaceStore = {
      listTaskOverlapWaits: vi.fn(async () => [episode]),
      getTask: vi.fn(async () => task),
      claimTaskOverlapWait: vi.fn(async (claim: any) => (episode = { ...episode, owner: claim.owner, phase: "analyzing", revision: episode.revision + 1 })),
      completeTaskOverlapWait: vi.fn(async (input: any) => (episode = { ...episode, ...input, revision: episode.revision + 1 })),
    } as any;

    await synchronizeOverlapWaitBeforeExecution({ task, store: workspaceStore, worktreePath: fx.waitingPath, owner: "owner-a", repository: "repo-a" });
    expect(episode.phase).toBe("freshness-pending");
    expect(episode.receipt.deliveryProofs).toEqual([expect.objectContaining({ repository: "repo-a", freshness: "proven" })]);

    await synchronizeOverlapWaitBeforeExecution({
      task, store: workspaceStore, worktreePath: fx.waitingPath, owner: "owner-b", repository: "repo-b",
      refresh: async () => { git(fx.waitingPath, "merge", "--ff-only", fx.c1); },
    });
    expect(episode.phase).toBe("revalidation-pending");
    expect(episode.receipt.deliveryProofs.map((proof: any) => proof.repository)).toEqual(["repo-a", "repo-b"]);
  });

  it("keeps historical optional acquisition behavior when no episode exists", async () => {
    const fx = await fixture();
    const refresh = vi.fn();
    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: store(fx.c1, false), worktreePath: fx.waitingPath, owner: "owner-1", refresh })).resolves.toEqual({ episodeIds: [] });
    expect(refresh).not.toHaveBeenCalled();
  });
});
