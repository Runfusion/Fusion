/*
FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
The claim this file exists to prove is about git's real answers, not about a fake's: a squash-merged and
cleaned-up card's local ref is GONE, a fully-merged ref is an ancestor of its target, a divergent one is not,
and a directory that is not a repository yields "could not ask" rather than absence. An injected runner can
assert the mapping; only a real repository can assert that the mapping matches what git actually returns for
`show-ref --verify --quiet` and `merge-base --is-ancestor`, including exit 128 on a non-repository cwd — the
exact ambiguity that is why this repo chose `show-ref` over `rev-parse --verify` in the first place.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings, type Task, type WorkflowWorkItem } from "@fusion/core";
import { resolvePostMergeProducerSurface, type PostMergeProducerSurfaceStore } from "../merge/post-merge-producer-surface.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function commitFile(repo: string, file: string, branch?: string): string {
  if (branch) git(repo, ["checkout", "-q", branch]);
  execFileSync("bash", ["-c", `echo content > ${file}`], { cwd: repo });
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.email=engine@fusion.test", "-c", "user.name=Fusion Engine", "commit", "-q", "-m", `feat: ${file}`]);
  return git(repo, ["rev-parse", "HEAD"]);
}

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function storeWith(items: WorkflowWorkItem[]): PostMergeProducerSurfaceStore {
  return {
    getRootDir: () => root,
    getSettings: async () => ({ ...DEFAULT_SETTINGS } as Settings),
    listWorkflowWorkItemsForTask: async () => items,
  } as unknown as PostMergeProducerSurfaceStore;
}

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-450",
    branch: "fusion/rufu-450",
    mergeDetails: { mergeConfirmed: true },
    ...overrides,
  } as Task;
}

/** Nothing claimable: the card's only continuation is a terminal row, which is RUFU-326's measured state. */
const DONE_ITEMS = [{
  id: "wi-1", runId: "run-1", taskId: "RUFU-450", nodeId: "post-merge-verification",
  kind: "task", state: "failed", attempt: 1, leaseExpiresAt: null,
  updatedAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
} as unknown as WorkflowWorkItem];

let root = "";
let scratch = "";

describeIfGit("resolvePostMergeProducerSurface against a real repository", () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "fusion-rufu-450-"));
    root = join(scratch, "repo");
    git(scratch, ["init", "-q", "-b", "main", "repo"]);
    git(root, ["-c", "user.email=engine@fusion.test", "-c", "user.name=Fusion Engine", "commit", "-q", "--allow-empty", "-m", "chore: seed"]);
    git(root, ["checkout", "-q", "-b", "fusion/rufu-450"]);
    commitFile(root, "work.txt");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("says ref-divergent while the target still owes the branch's commit", async () => {
    const observation = await resolvePostMergeProducerSurface(storeWith(DONE_ITEMS), card(), { now: () => NOW });
    expect(observation).toEqual({ surface: "ref-divergent", mergeConfirmed: true, producerCanRun: false });
  });

  it("says ref-merged once the target really contains the branch (RUFU-326's 0/0 range)", async () => {
    git(root, ["checkout", "-q", "main"]);
    git(root, ["-c", "user.email=engine@fusion.test", "-c", "user.name=Fusion Engine", "merge", "--no-ff", "-q", "fusion/rufu-450", "-m", "merge: rufu-450"]);

    const observation = await resolvePostMergeProducerSurface(storeWith(DONE_ITEMS), card(), { now: () => NOW });
    expect(observation?.surface).toBe("ref-merged");
  });

  it("says ref-absent after branch cleanup deletes the ref, with the pointer left stale", async () => {
    git(root, ["checkout", "-q", "main"]);
    git(root, ["branch", "-D", "fusion/rufu-450"]);

    // The pointer cleanup that makes the pointer test unreachable: `worktree` cleared, `branch` left stale.
    const observation = await resolvePostMergeProducerSurface(
      storeWith(DONE_ITEMS), card({ worktree: null }), { now: () => NOW },
    );
    expect(observation).toEqual({ surface: "ref-absent", mergeConfirmed: true, producerCanRun: false });
  });

  it("still probes the derived ref name when the branch pointer itself is gone", async () => {
    git(root, ["checkout", "-q", "-b", "fusion/rufu-450", "main"]);
    const observation = await resolvePostMergeProducerSurface(
      storeWith(DONE_ITEMS), card({ branch: null }), { now: () => NOW },
    );
    expect(observation?.surface).toBe("ref-merged");
    git(root, ["checkout", "-q", "main"]);
  });

  it("reports unknown instead of absence when the root is not a repository (an unreadable probe is not proof)", async () => {
    // The scratch directory itself was never a repository: git answers 128 there, which is "could not ask".
    const observation = await resolvePostMergeProducerSurface(
      {
        getRootDir: () => scratch,
        getSettings: async () => ({ ...DEFAULT_SETTINGS } as Settings),
        listWorkflowWorkItemsForTask: async () => DONE_ITEMS,
      } as unknown as PostMergeProducerSurfaceStore,
      card(),
      { now: () => NOW },
    );
    expect(observation?.surface).toBe("unknown");
    // And a probe of a repository that cannot resolve its merge target is likewise not an exemption.
    expect(observation?.mergeConfirmed).toBe(true);
  });

  it("keeps a claimable continuation reported as a live producer over the same git state", async () => {
    const claimable = [{ ...DONE_ITEMS[0]!, state: "runnable" }] as unknown as WorkflowWorkItem[];
    const observation = await resolvePostMergeProducerSurface(storeWith(claimable), card(), { now: () => NOW });
    expect(observation?.producerCanRun).toBe(true);
    expect(observation?.surface).toBe("ref-merged");
  });
});
