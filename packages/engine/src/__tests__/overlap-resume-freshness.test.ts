import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlapResumeSynchronizationError, __resetOverlapReconciliationDiagnosticDedup, synchronizeOverlapWaitBeforeExecution } from "../executor/overlap-resume-gate.js";

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
    expect(result.analysis?.decision).toBe("briefing");
    expect(mock.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ phase: "ready" }));
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
    expect(episode.phase).toBe("ready");
    expect(episode.receipt.deliveryProofs.map((proof: any) => proof.repository)).toEqual(["repo-a", "repo-b"]);
  });

  it("keeps historical optional acquisition behavior when no episode exists", async () => {
    const fx = await fixture();
    const refresh = vi.fn();
    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: store(fx.c1, false), worktreePath: fx.waitingPath, owner: "owner-1", refresh })).resolves.toEqual({ episodeIds: [] });
    expect(refresh).not.toHaveBeenCalled();
  });
});

/*
FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
FN-429 symptom verification. FN-428 waited on FN-419/FN-424/FN-426; main was then rebased onto origin/main,
so every delivered commit kept its patch and its Fusion trailers while changing SHA, and the predecessors'
`mergeDetails.commitSha` still named the pre-rebase SHAs. The gate proved freshness with `merge-base
--is-ancestor <landedSha> HEAD`, so a fresh checkout of the rewritten integration branch refused
`freshness-unproven` before Preflight and no refresh could ever repair it. These cases reproduce that exact
shape (remembered SHA not an ancestor, rewritten SHA an ancestor) and prove the reconciled resume, while
every negative control keeps a bounded refusal in the same phase.
*/
const OWNED_TRAILERS = ["Fusion-Task-Id: FN-A", "Fusion-Task-Lineage: lineage-a"];

async function freshExecutionCheckout(root: string, branch: string, startPoint = "main") {
  const path = `${root}-${branch.replaceAll("/", "-")}`;
  roots.push(path);
  git(root, "worktree", "add", "-q", "-b", branch, path, startPoint);
  return path;
}

async function rebaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion-overlap-rebase-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fusion@example.test");
  git(root, "config", "user.name", "Fusion Test");
  await writeFile(join(root, "shared.ts"), "export function sharedApi(a: string) {}\n");
  await writeFile(join(root, "other.ts"), "export const other = 0;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "C0");
  const c0 = git(root, "rev-parse", "HEAD");

  const deliver = async (branch: string, file: string, content: string, subject: string, trailers: string[]) => {
    git(root, "checkout", "-q", "-b", branch, c0);
    await writeFile(join(root, file), content);
    git(root, "add", ".");
    git(root, "commit", "-qm", subject, "-m", trailers.join("\n"));
    return git(root, "rev-parse", "HEAD");
  };
  const before1 = await deliver("holder-a", "shared.ts", "export function sharedApi(a: number) {}\n", "feat(FN-A): change the shared API", OWNED_TRAILERS);
  const before2 = await deliver("holder-a2", "other.ts", "export const other = 1;\n", "feat(FN-A2): change the other module", ["Fusion-Task-Id: FN-A2", "Fusion-Task-Lineage: lineage-a2"]);
  const abandoned = await deliver("abandoned", "abandoned.ts", "export const abandoned = true;\n", "feat(FN-A2): never landed", ["Fusion-Task-Id: FN-A2", "Fusion-Task-Lineage: lineage-a2"]);

  // The integration branch moves onto a new parent, then both deliveries are rebased onto it unchanged.
  git(root, "checkout", "-q", "main");
  await writeFile(join(root, "upstream.ts"), "export const upstream = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream work");
  const upstream = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "holder-a");
  git(root, "rebase", "-q", "--onto", "main", c0, "holder-a");
  const after1 = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--ff-only", "holder-a");
  git(root, "checkout", "-q", "holder-a2");
  git(root, "rebase", "-q", "--onto", "main", c0, "holder-a2");
  const after2 = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--ff-only", "holder-a2");
  git(root, "branch", "release", c0);

  const execution = await freshExecutionCheckout(root, "fusion/fn-b");
  return { root, execution, c0, upstream, before1, after1, before2, after2, abandoned };
}

interface EpisodeSeed {
  episodeId: string;
  blockerTaskId: string;
  blockerLineageId?: string;
  phase?: string;
  deliveries: Array<Record<string, unknown>>;
  receipt?: Record<string, unknown>;
}

function episodeStore(seeds: EpisodeSeed[], overrides: { complete?: (input: any) => unknown; getTask?: (id: string) => Promise<any> } = {}) {
  const episodes = seeds.map((seed) => ({
    taskId: "FN-B",
    episodeId: seed.episodeId,
    blockerTaskId: seed.blockerTaskId,
    blockerLineageId: seed.blockerLineageId,
    phase: seed.phase ?? "observed",
    revision: 1,
    attempt: 0,
    observation: { deliveries: seed.deliveries },
    ...(seed.receipt ? { receipt: seed.receipt } : {}),
  }) as any);
  const published: any[] = [];
  const store = {
    listTaskOverlapWaits: vi.fn(async (_id: string, options?: { pendingOnly?: boolean }) =>
      options?.pendingOnly ? episodes.filter((episode) => episode.phase !== "delivered" && episode.phase !== "cancelled") : episodes),
    getTask: vi.fn(overrides.getTask ?? (async (id: string) => id === "FN-B" ? task : { id, summary: `${id} delivered`, mergeDetails: {} })),
    claimTaskOverlapWait: vi.fn(async (claim: any) => {
      const index = episodes.findIndex((episode) => episode.episodeId === claim.episodeId);
      if (index < 0 || episodes[index].revision !== claim.expectedRevision) return null;
      episodes[index] = { ...episodes[index], phase: "analyzing", owner: claim.owner, revision: episodes[index].revision + 1, attempt: episodes[index].attempt + 1 };
      return episodes[index];
    }),
    completeTaskOverlapWait: vi.fn(async (input: any) => {
      if (overrides.complete) return overrides.complete(input) as any;
      const index = episodes.findIndex((episode) => episode.episodeId === input.episodeId);
      if (index < 0 || episodes[index].revision !== input.expectedRevision || episodes[index].owner !== input.owner) return null;
      episodes[index] = { ...episodes[index], phase: input.phase, receipt: input.receipt, revision: episodes[index].revision + 1 };
      published.push(episodes[index]);
      return episodes[index];
    }),
    logEntry: vi.fn(async () => undefined),
  } as any;
  return { store, episodes, published };
}

const ownedDelivery = (landedSha: string, extra: Record<string, unknown> = {}) => ({
  blockerTaskId: "FN-A", blockerLineageId: "lineage-a", repository: ".", landedSha, summary: "Changed the shared API", evidence: "merge-details", ...extra,
});

describe("overlap resume reconciliation of a rebased delivery (FN-429)", () => {
  beforeEach(() => { __resetOverlapReconciliationDiagnosticDedup(); });

  it("reproduces the rewritten-SHA shape and resumes with a reconciled proof", async () => {
    const fx = await rebaseFixture();
    // Reproduction control: the remembered SHA is gone from the rewritten integration branch.
    expect(() => git(fx.execution, "merge-base", "--is-ancestor", fx.before1, "HEAD")).toThrow();
    expect(git(fx.execution, "merge-base", "--is-ancestor", fx.after1, "HEAD")).toBe("");

    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] }]);
    const result = await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" });

    expect(h.episodes[0].phase).toBe("ready");
    expect(h.episodes[0].receipt.freshness).toBe("proven");
    expect(h.episodes[0].receipt.deliveryProofs[0]).toMatchObject({
      repository: ".", landedSha: fx.before1, reconciledSha: fx.after1, reconciliationProof: "patch-id+task-trailer", freshness: "proven",
    });
    // Contract evidence is recaptured from the rewritten commit, not from the vanished one.
    expect(result.analysis?.deliveries[0]).toMatchObject({ landedSha: fx.before1, reconciledSha: fx.after1, evidence: "git-recapture", paths: [expect.objectContaining({ path: "shared.ts" })] });
    expect(h.store.logEntry).toHaveBeenCalledWith("FN-B", expect.stringContaining(`reconciledSha=${fx.after1.slice(0, 12)}`));
  });

  it.each([
    ["a patch changed by conflict resolution", "patch", "no-equivalent-delivery"],
    ["a foreign Fusion trailer", "foreign", "identity-foreign"],
    ["a target that does not contain the rewrite", "target", "target-mismatch"],
    ["a delivery that genuinely never landed", "absent", "no-equivalent-delivery"],
  ] as const)("refuses %s without inventing a reconciliation", async (_label, shape, reason) => {
    const fx = await rebaseFixture();
    let delivery: Record<string, unknown>;
    let execution = fx.execution;
    if (shape === "patch") {
      // The rewrite landed with a conflict resolution, so its patch is no longer the delivered one.
      execution = await freshExecutionCheckout(fx.root, "fusion/fn-b-patch", fx.upstream);
      await writeFile(join(execution, "shared.ts"), "export function sharedApi(a: bigint) {}\n");
      git(execution, "add", ".");
      git(execution, "commit", "-qm", "feat(FN-A): change the shared API", "-m", OWNED_TRAILERS.join("\n"));
      delivery = ownedDelivery(fx.before1);
    } else if (shape === "foreign") {
      delivery = { ...ownedDelivery(fx.before1), blockerTaskId: "FN-FOREIGN", blockerLineageId: "lineage-foreign" };
    } else if (shape === "target") {
      delivery = ownedDelivery(fx.before1, { target: "release" });
    } else {
      delivery = { ...ownedDelivery(fx.abandoned), blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2" };
    }
    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: String(delivery.blockerTaskId), blockerLineageId: delivery.blockerLineageId as string, deliveries: [delivery] }]);

    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: execution, owner: "owner-1" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "freshness-unproven" });
    expect(h.episodes[0].phase).toBe("freshness-pending");
    expect(h.episodes[0].receipt.deliveryProofs[0].reconciledSha).toBeUndefined();
    expect(h.store.logEntry).toHaveBeenCalledWith("FN-B", expect.stringContaining(`unresolved reason=${reason}`));
  });

  it("refuses an unreadable delivered object instead of reconciling it", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery("0".repeat(40))] }]);
    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "freshness-unproven" });
    expect(h.published.some((episode: any) => episode.receipt?.deliveryProofs?.some((proof: any) => proof.reconciledSha))).toBe(false);
  });

  it("never inspects a rewrite before preserving a dirty stale checkout", async () => {
    const fx = await rebaseFixture();
    await writeFile(join(fx.execution, "local.txt"), "keep me exactly\n");
    const head = git(fx.execution, "rev-parse", "HEAD");
    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] }]);

    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "stale-dirty-worktree" });
    expect(await readFile(join(fx.execution, "local.txt"), "utf8")).toBe("keep me exactly\n");
    expect(git(fx.execution, "rev-parse", "HEAD")).toBe(head);
    expect(h.episodes[0].receipt.freshness).toBe("conflict");
    // No reconciliation diagnostic: the dirty guard refused before any rewrite was inspected.
    expect(h.store.logEntry).not.toHaveBeenCalled();
  });

  it("reconciles every rewritten predecessor of a multi-blocker wait", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([
      { episodeId: "episode-a", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] },
      { episodeId: "episode-a2", blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2", deliveries: [{ ...ownedDelivery(fx.before2), blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2" }] },
    ]);
    await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" });
    expect(h.episodes.map((episode: any) => episode.phase)).toEqual(["ready", "ready"]);
    expect(h.episodes[0].receipt.deliveryProofs.map((proof: any) => proof.reconciledSha)).toEqual([fx.after1, fx.after2]);
  });

  it("mixes a rewritten predecessor with an untouched one", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([
      { episodeId: "episode-a", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] },
      { episodeId: "episode-a2", blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2", deliveries: [{ ...ownedDelivery(fx.after2), blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2" }] },
    ]);
    await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" });
    const proofs = h.episodes[0].receipt.deliveryProofs;
    expect(proofs[0]).toMatchObject({ landedSha: fx.before1, reconciledSha: fx.after1 });
    expect(proofs[1]).toMatchObject({ landedSha: fx.after2 });
    expect(proofs[1].reconciledSha).toBeUndefined();
  });

  it("refuses the whole wait when one predecessor never landed", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([
      { episodeId: "episode-a", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] },
      { episodeId: "episode-a2", blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2", deliveries: [{ ...ownedDelivery(fx.abandoned), blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2" }] },
    ]);
    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "freshness-unproven" });
    expect(h.episodes.every((episode: any) => episode.phase === "freshness-pending")).toBe(true);
  });

  it.each(["observed", "analyzing", "freshness-pending"] as const)("reconciles from the %s phase", async (phase) => {
    const fx = await rebaseFixture();
    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", phase, deliveries: [ownedDelivery(fx.before1)] }]);
    await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" });
    expect(h.episodes[0].phase).toBe("ready");
  });

  it.each(["ready", "delivered", "cancelled"] as const)("does not re-derive a rewrite for the %s phase", async (phase) => {
    const fx = await rebaseFixture();
    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", phase, deliveries: [ownedDelivery(fx.before1)], receipt: { briefing: "already decided" } }]);
    const result = await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" });
    expect(h.store.claimTaskOverlapWait).not.toHaveBeenCalled();
    expect(h.store.logEntry).not.toHaveBeenCalled();
    expect(result.episodeIds).toEqual(phase === "ready" ? ["episode-1"] : []);
  });

  it("reconciles from the durable snapshot when the predecessor row is gone", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore(
      [{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] }],
      { getTask: async (id: string) => id === "FN-B" ? task : Promise.reject(new Error("blocker deleted")) },
    );
    await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" });
    expect(h.store.getTask).not.toHaveBeenCalledWith("FN-A");
    expect(h.episodes[0].receipt.deliveryProofs[0]).toMatchObject({ landedSha: fx.before1, reconciledSha: fx.after1 });
  });

  it("does not authorize a workspace wait when only one repository reconciles", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([{
      episodeId: "workspace-episode", blockerTaskId: "FN-A", blockerLineageId: "lineage-a",
      deliveries: [
        ownedDelivery(fx.before1, { repository: "repo-a", target: "main" }),
        { ...ownedDelivery(fx.abandoned), repository: "repo-b", target: "release", blockerTaskId: "FN-A2", blockerLineageId: "lineage-a2" },
      ],
    }]);
    await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-a", repository: "repo-a" });
    expect(h.episodes[0].phase).toBe("freshness-pending");
    expect(h.episodes[0].receipt.deliveryProofs[0]).toMatchObject({ repository: "repo-a", reconciledSha: fx.after1, freshness: "proven" });

    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-b", repository: "repo-b" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "freshness-unproven" });
    expect(h.episodes[0].phase).toBe("freshness-pending");
  });

  it("reuses a persisted reconciliation after a restart without re-deriving it", async () => {
    const fx = await rebaseFixture();
    const recreated = await freshExecutionCheckout(fx.root, "fusion/fn-b-restarted");
    const h = episodeStore([{
      episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", phase: "freshness-pending",
      deliveries: [ownedDelivery(fx.before1)],
      receipt: { decision: "briefing", freshness: "pending", commonFiles: [], decisionFingerprint: "fp", decidedAt: new Date().toISOString(), deliveryProofs: [{ repository: ".", landedSha: fx.before1, reconciledSha: fx.after1, reconciliationProof: "patch-id+task-trailer", freshness: "pending" }] },
    }]);
    await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: recreated, owner: "owner-after-restart" });
    expect(h.episodes[0].phase).toBe("ready");
    expect(h.episodes[0].receipt.deliveryProofs[0]).toMatchObject({ landedSha: fx.before1, reconciledSha: fx.after1, reconciliationProof: "patch-id+task-trailer" });
    // No diagnostic: the memorized proof was honored, so nothing had to be re-derived.
    expect(h.store.logEntry).not.toHaveBeenCalled();
  });

  it("ignores a memorized reconciliation the current checkout does not contain", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([{
      episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", phase: "freshness-pending",
      deliveries: [ownedDelivery(fx.before1)],
      receipt: { decision: "briefing", freshness: "pending", commonFiles: [], decisionFingerprint: "fp", decidedAt: new Date().toISOString(), deliveryProofs: [{ repository: ".", landedSha: fx.before1, reconciledSha: fx.abandoned, reconciliationProof: "patch-id+task-trailer", freshness: "pending" }] },
    }]);
    await synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" });
    expect(h.episodes[0].receipt.deliveryProofs[0]).toMatchObject({ reconciledSha: fx.after1 });
    expect(h.store.logEntry).toHaveBeenCalledWith("FN-B", expect.stringContaining(`reconciledSha=${fx.after1.slice(0, 12)}`));
  });

  it("treats a lost publication race as superseded, never as a reconciled success", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] }], { complete: () => null });
    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "superseded" });
  });

  it("treats a paused task as superseded before publishing a reconciliation", async () => {
    const fx = await rebaseFixture();
    const h = episodeStore([{ episodeId: "episode-1", blockerTaskId: "FN-A", blockerLineageId: "lineage-a", deliveries: [ownedDelivery(fx.before1)] }],
      { getTask: async (id: string) => id === "FN-B" ? { ...task, userPaused: true } : { id } });
    await expect(synchronizeOverlapWaitBeforeExecution({ task, store: h.store, worktreePath: fx.execution, owner: "owner-1" }))
      .rejects.toMatchObject({ name: "OverlapResumeSynchronizationError", reason: "superseded" });
  });
});
