import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_overlap_wait" });
const overlap = (id: string) => ({
  signature: `file-scope:${id}`,
  blockedBy: null,
  overlapBlockedBy: id,
  action: `queued behind ${id}`,
});

pgDescribe("overlap wait persistence", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("keeps one durable episode when an identical wait is republished and its marker clears", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    await h.store().updateTask(waiting.id, { overlapBlockedBy: null, status: null });

    const episodes = await h.store().listTaskOverlapWaits(waiting.id);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ blockerTaskId: blocker.id, phase: "observed", revision: 1 });
  });

  it("preserves A then C as separate unconsumed observations", async () => {
    const [a, c, waiting] = await Promise.all([
      h.store().createTask({ description: "A" }),
      h.store().createTask({ description: "C" }),
      h.store().createTask({ description: "waiting" }),
    ]);
    await h.store().transitionQueuedEpisode(waiting.id, overlap(a.id));
    await h.store().transitionQueuedEpisode(waiting.id, overlap(c.id));
    await h.store().updateTask(waiting.id, { overlapBlockedBy: null, status: null });
    expect((await h.store().listTaskOverlapWaits(waiting.id, { pendingOnly: true })).map((row) => row.blockerTaskId)).toEqual([a.id, c.id]);
  });

  it("fences stale owners and writes the release receipt with its task log atomically", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1" });
    expect(claim?.phase).toBe("analyzing");
    await expect(h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-2" })).resolves.toBeNull();

    const receipt = {
      decision: "briefing" as const,
      freshness: "proven" as const,
      commonFiles: ["src/shared.ts"],
      deliveryProofs: [{ repository: ".", landedSha: "abc", landedFiles: ["src/shared.ts"] }],
      decisionFingerprint: "decision-1",
      decidedAt: new Date().toISOString(),
    };
    const completed = await h.store().completeTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1", receipt });
    expect(completed).toMatchObject({ phase: "ready", receipt });
    expect((await h.store().getTask(waiting.id)).log?.filter((entry) => entry.dedupeKey?.startsWith("overlap-wait-release:"))).toHaveLength(1);
  });

  /*
  FNXC:OverlapWaitSynchronization 2026-09-12-17:20:
  The nominal path: a task WITH a plan, claiming and publishing a complete unchanged execution identity, must
  be released. This case was absent, and the identity fence was consequently never exercised end to end — the
  positive test below passes NO identity (short-circuiting the comparison) and the negative tests expect a
  refusal, which the defect produced for the wrong reason. FN-359/FN-362 were refused 122 times each because
  publication compared the caller's prompt hash against `sha256(row.prompt)` on a table with no `prompt` column.
  */
  it("releases a planned task whose execution identity is unchanged between claim and publication", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { prompt: "## Mission\nUse `sharedApi`", worktree: "/work/waiting", branch: "fusion/waiting", branchWriteOrigin: "engine", checkoutLeaseEpoch: 3 });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const live = await h.store().getTask(waiting.id);
    const identity = {
      taskLineageId: live.lineageId,
      planFingerprint: createHash("sha256").update(live.prompt!).digest("hex"),
      checkoutEpoch: "3",
      worktree: "/work/waiting",
      branch: "fusion/waiting",
      headSha: "head-1",
      repository: ".",
    };
    const claim = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision,
      owner: "executor-1", checkoutEpoch: "3", executionIdentity: identity,
    });
    expect(claim).toMatchObject({ phase: "analyzing", planFingerprint: identity.planFingerprint });

    const completed = await h.store().completeTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1",
      executionIdentity: identity,
      receipt: { decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [], decisionFingerprint: "decision-1", decidedAt: new Date().toISOString() },
    });
    expect(completed).toMatchObject({ phase: "ready" });
  });

  /*
  FNXC:OverlapWaitSynchronization 2026-09-12-17:20:
  A claim must never erase the durable plan fingerprint. `revalidatePendingOverlapWaitsAtGraphNode` decides
  whether a targeted repair produced a genuinely new plan by comparing against this column; a null-wipe on
  claim made every repair look like a plan change.
  */
  it("preserves the durable plan fingerprint across a claim that supplies no identity", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const first = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision,
      owner: "executor-1", executionIdentity: { planFingerprint: "plan-1" },
    });
    expect(first?.planFingerprint).toBe("plan-1");
    const reclaimed = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: first!.revision, owner: "executor-2",
    });
    expect(reclaimed?.planFingerprint).toBe("plan-1");
  });

  it("rejects a completion after the claimed plan or checkout identity changes", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { prompt: "## Mission\nUse old contract", worktree: "/work/old", checkoutLeaseEpoch: 1 });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    expect((await h.store().getTask(waiting.id)).prompt).toBe("## Mission\nUse old contract");
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const identity = {
      planFingerprint: createHash("sha256").update("## Mission\nUse old contract").digest("hex"),
      worktree: "/work/old",
      checkoutEpoch: "1",
      headSha: "head-old",
      repository: ".",
    };
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1", checkoutEpoch: "1", executionIdentity: identity });
    expect(claim).not.toBeNull();
    await h.store().updateTask(waiting.id, { prompt: "## Mission\nUse new contract", worktree: "/work/new" });
    await expect(h.store().completeTaskOverlapWait({
      taskId: waiting.id,
      episodeId: observed.episodeId,
      expectedRevision: claim!.revision,
      owner: "executor-1",
      receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "stale", decidedAt: new Date().toISOString() },
    })).resolves.toBeNull();
  });

  it("rejects completion when the claimed checkout epoch disappears from the durable task", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { checkoutLeaseEpoch: 7 });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const identity = { checkoutEpoch: "7" };
    const claim = await h.store().claimTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision,
      owner: "executor-epoch", checkoutEpoch: "7", executionIdentity: identity,
    });
    expect(claim).not.toBeNull();

    await h.store().updateTask(waiting.id, { checkoutLeaseEpoch: null } as any);
    await expect(h.store().completeTaskOverlapWait({
      taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision,
      owner: "executor-epoch", executionIdentity: identity,
      receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "epoch-cleared", decidedAt: new Date().toISOString() },
    })).resolves.toBeNull();
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.phase).toBe("analyzing");
  });

  it("keeps merger-published workspace rename and deletion proof after the blocker is deleted", async () => {
    const blocker = await h.store().createTask({ description: "workspace holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    await h.store().publishTaskOverlapDeliveries(blocker.id, [
      { blockerTaskId: blocker.id, blockerLineageId: blocker.lineageId, repository: "repo-a", target: "main", landedSha: "sha-repo-a", evidence: "workspace-landing", paths: [{ repository: "repo-a", previousPath: "src/old.ts", path: "src/shared.ts", status: "renamed" }] },
      { blockerTaskId: blocker.id, blockerLineageId: blocker.lineageId, repository: "repo-b", target: "main", landedSha: "sha-repo-b", evidence: "workspace-landing", paths: [{ repository: "repo-b", path: "src/other.ts", status: "deleted" }] },
    ]);
    await h.store().deleteTask(blocker.id);

    const [episode] = await h.store().listTaskOverlapWaits(waiting.id);
    expect((episode?.observation as any)?.deliveries).toEqual([
      expect.objectContaining({ repository: "repo-a", paths: [{ repository: "repo-a", previousPath: "src/old.ts", path: "src/shared.ts", status: "renamed" }] }),
      expect.objectContaining({ repository: "repo-b", paths: [{ repository: "repo-b", path: "src/other.ts", status: "deleted" }] }),
    ]);
  });

  it("rejects recaptured HEAD, target, repository, node incarnation, and checkout epoch races", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().updateTask(waiting.id, { checkoutLeaseEpoch: 1, checkoutNodeId: "execute" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const identity = { taskLineageId: waiting.lineageId, planFingerprint: "plan-1", headSha: "head-1", repository: "repo-a", target: "main", nodeId: "execute", nodeInstanceId: "instance-1", checkoutEpoch: "1" };
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1", checkoutEpoch: "1", executionIdentity: identity });
    expect(claim).not.toBeNull();
    for (const patch of [
      { headSha: "head-2" }, { repository: "repo-b" }, { target: "release" },
      { nodeId: "verify" }, { nodeInstanceId: "instance-2" }, { checkoutEpoch: "2" },
      // A plan revision landing mid-analysis must still refuse publication.
      { planFingerprint: "plan-2" },
    ]) {
      await expect(h.store().completeTaskOverlapWait({
        taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: claim!.revision, owner: "executor-1",
        executionIdentity: { ...identity, ...patch },
        receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "race", decidedAt: new Date().toISOString() },
      })).resolves.toBeNull();
    }
  });

  it("invalidates an in-flight generation on Reset", async () => {
    const blocker = await h.store().createTask({ description: "holder" });
    const waiting = await h.store().createTask({ description: "waiting" });
    await h.store().transitionQueuedEpisode(waiting.id, overlap(blocker.id));
    const observed = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: observed.episodeId, expectedRevision: observed.revision, owner: "executor-1" });
    await h.store().resetTaskPublication(waiting.id, "triage");
    await expect(h.store().completeTaskOverlapWait({
      taskId: waiting.id,
      episodeId: observed.episodeId,
      expectedRevision: claim!.revision,
      owner: "executor-1",
      receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "stale", decidedAt: new Date().toISOString() },
    })).resolves.toBeNull();
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.phase).toBe("cancelled");
  });
});
