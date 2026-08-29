/*
FNXC:MergeReliability 2026-08-10-19:37:
FN-8923 requires lane evidence to use the real claim, abort, and settle implementation instead of
separate AbortControllers; otherwise its successor assertion cannot establish the bounded-latch
orphan situation it claims to characterize.

These are characterization assertions, not desired-behavior assertions. Layer A drives the real
claim, abort, and bounded-settle methods only to establish the orphan/successor situation; it
never assigns an inventory disposition or provides an execution proof. Layer B is the only
production-entry-point evidence tier for inventory rows. The final inventory honestly records
deep rows as unresolved where the real production entry point cannot be isolated without changing
production exports.
*/
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ProjectEngine } from "../project-engine.js";
import { seedMergeLaneState } from "./_project-engine-merge-lane-fixture.js";
import { landOneRepo, landWorkspaceTask, runAiMerge, writeTransientMergeStatus } from "../merge/merger-ai.js";

afterEach(() => {
  vi.useRealTimers();
});

const temporaryRepos = new Set<string>();
afterAll(() => {
  for (const directory of temporaryRepos) rmSync(directory, { recursive: true, force: true });
});

function git(directory: string, args: string): string {
  return execSync(`git ${args}`, { cwd: directory, encoding: "utf8" }).trim();
}

/*
FNXC:MergeReliability 2026-08-23-21:20:
The task branch is lowercase (`fusion/fn-8923`). Production derives the merge branch by lowercasing
the task ID, then FN-090's episode-identity check compares that derived name against the live
`task.branch`. An uppercase fixture branch made those two disagree on EVERY pass, so the merge body
invalidated its reconciliation episode and the unbounded rebuild loop in runAiMerge spun until the
test timed out instead of reaching the abort seam under test.
*/
/** A real clean-room-sized repository so an abort can land during the production merge tail. */
function createMergeRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "fn-8923-merge-"));
  temporaryRepos.add(directory);
  git(directory, "init -q -b main");
  git(directory, "config user.email fn8923@example.test");
  git(directory, "config user.name FN-8923");
  writeFileSync(join(directory, "base.txt"), "base\\n");
  git(directory, "add -A && git commit -q -m base");
  git(directory, "checkout -q -b fusion/fn-8923");
  writeFileSync(join(directory, "feature.txt"), "feature\\n");
  git(directory, "add -A && git commit -q -m feature");
  git(directory, "branch group-main main");
  git(directory, "checkout -q main");
  return directory;
}

function createRecordingStore(controller: AbortController, options: { sharedGroup?: boolean; onMergeDetailsPersist?: () => void; onIntegrationRefAdvance?: () => void } = {}) {
  const task: Record<string, unknown> = {
    /* FNXC:RequiredPreMergeSteps 2026-08-23-20:25: merge-mechanics fixture, not a review-gating one.
       The merge door refuses a card whose ENABLED optional pre-merge groups produced no result, and
       the built-in workflow enables Plan and Code Review by default, so an unspecified list failed
       the door before the orphan-write behaviour under test could run. The empty list states the
       intent this fixture always had. */
    enabledWorkflowSteps: [],
    id: "FN-8923", column: "in-review", status: null, branch: "fusion/fn-8923", title: "orphan evidence", steps: [],
    ...(options.sharedGroup ? { branchContext: { groupId: "BG-8923", source: "planning", assignmentMode: "shared" } } : {}),
  };
  const records: Array<{ generation: string; writer: string; args: unknown[] }> = [];
  /*
  FNXC:MergeReliability 2026-08-11-00:37:
  FN-8923's workspace race must partition concurrent production bodies structurally. A mutable
  recorder label can change while an awaited writer resumes and falsely attribute that write.
  */
  const storeFor = (generation: string) => {
    const record = (writer: string) => vi.fn(async (...args: unknown[]) => { records.push({ generation, writer, args }); });
    return {
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 0 } })),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        records.push({ generation, writer: "updateTask", args: [_id, patch] });
        Object.assign(task, patch);
        if (patch.mergeDetails) options.onMergeDetailsPersist?.();
        return task;
      }),
      /* FNXC:MergeReliability 2026-08-23-20:30: the durable merge-review reconciliation path
         atomically records its episode before a repository can land, so a store double without
         updateTaskAtomic fails with a TypeError long before the orphan-write behaviour under test.
         Same faithful shape as merger-ai.test.ts's store. */
      updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Record<string, unknown>) => Record<string, unknown> | undefined) => {
        const patch = await updater(task);
        if (patch) {
          records.push({ generation, writer: "updateTaskAtomic", args: [_id, patch] });
          Object.assign(task, patch);
          if (patch.mergeDetails) options.onMergeDetailsPersist?.();
        }
        return task;
      }),
      mergeWorkspaceWorktreeEntry: vi.fn(async (_id: string, repoRelPath: string, patch: Record<string, unknown>, mergeOptions?: { requireExistingEntry?: boolean }) => {
        records.push({ generation, writer: "mergeWorkspaceWorktreeEntry", args: [_id, repoRelPath, patch, mergeOptions] });
        const current = (task.workspaceWorktrees as Record<string, Record<string, unknown>> | undefined) ?? {};
        const existing = current[repoRelPath];
        if (mergeOptions?.requireExistingEntry && !existing) return task;
        task.workspaceWorktrees = { ...current, [repoRelPath]: { ...existing, ...patch } };
        return task;
      }),
      moveTask: vi.fn(async (...args: unknown[]) => { records.push({ generation, writer: "moveTask", args }); task.column = args[1] as string; return task; }),
      logEntry: record("logEntry"), appendAgentLog: record("appendAgentLog"),
      emit: vi.fn((...args: unknown[]) => { records.push({ generation, writer: "emit", args }); }),
      recordRunAuditEvent: vi.fn(async (...args: unknown[]) => {
        records.push({ generation, writer: "recordRunAuditEvent", args });
        if ((args[0] as Record<string, unknown>)?.mutationType === "merge:integration-ref-advance") options.onIntegrationRefAdvance?.();
      }),
      upsertTaskCommitAssociation: record("upsertTaskCommitAssociation"),
      recordBranchGroupMemberLanded: record("recordBranchGroupMemberLanded"),
      getBranchGroup: vi.fn(() => options.sharedGroup ? { id: "BG-8923", branchName: "group-main", status: "open" } : null),
      listTasksByBranchGroup: vi.fn(async () => []),
      // This field makes the abort boundary explicit to the test's recorder.
      __abortController: controller,
    };
  };
  return { task, records, store: storeFor("orphan"), storeFor };
}

describe("FN-8923 orphan merge-body durable writes", () => {
  describe("Layer A — lane semantics", () => {
    it("releases a timed-out orphan and gives its successor a distinct live claim", async () => {
      vi.useFakeTimers();
      const engine = seedMergeLaneState(Object.create(ProjectEngine.prototype) as ProjectEngine) as unknown as {
        claimActiveMerge(taskId: string): AbortSignal;
        abortActiveMerge(taskId: string, reason: string): boolean;
        trackMergeBody(body: Promise<unknown>): Promise<unknown>;
        awaitPriorMergeBodySettle(): Promise<void>;
        mergeBodySettleTimeoutMs: number;
        mergeBodyInFlight: Promise<unknown> | null;
      };
      let resolveOrphan!: () => void;
      const orphanBody = new Promise<void>((resolve) => { resolveOrphan = resolve; });
      const orphanSignal = engine.claimActiveMerge("FN-8923");
      engine.trackMergeBody(orphanBody);
      engine.mergeBodySettleTimeoutMs = 1;

      expect(engine.abortActiveMerge("FN-8923", "test orphan")).toBe(true);
      const settle = engine.awaitPriorMergeBodySettle();
      await vi.advanceTimersByTimeAsync(1);
      await settle;

      expect(engine.mergeBodyInFlight).toBeNull();
      expect(orphanSignal.aborted).toBe(true);
      const successorSignal = engine.claimActiveMerge("FN-8923");
      expect(successorSignal.aborted).toBe(false);
      expect(successorSignal).not.toBe(orphanSignal);
      resolveOrphan();
      await Promise.resolve();
    });
  });

  describe("Layer B — production-path writes", () => {
    it("characterizes the FN-8912 transient-status fence at entry", async () => {
      const updateTask = vi.fn().mockResolvedValue(undefined); const controller = new AbortController(); controller.abort();
      await expect(writeTransientMergeStatus({ updateTask } as never, "FN-8923", controller.signal, "merging")).resolves.toBeUndefined();
      // Execution proof: this exported leaf is invoked directly, so an absent store call is not a skipped body.
      expect(updateTask).not.toHaveBeenCalled();
    });
    it("still writes transient status for a live generation", async () => {
      const updateTask = vi.fn().mockResolvedValue(undefined);
      await writeTransientMergeStatus({ updateTask } as never, "FN-8923", new AbortController().signal, "merging");
      expect(updateTask).toHaveBeenCalledWith("FN-8923", { status: "merging" });
    });

    it("attributes single-repository entry writes after a task-read abort boundary", async () => {
      const controller = new AbortController();
      const updateTask = vi.fn().mockResolvedValue(undefined);
      let writesAtAbort = -1;
      const store = {
        // Abort from the real task-read seam, then snapshot the recorder. This proves a
        // post-boundary call belongs to the orphan rather than test setup or a successor.
        getTask: vi.fn().mockImplementation(async () => {
          controller.abort("orphaned generation after task read");
          writesAtAbort = updateTask.mock.calls.length;
          return { id: "FN-8923", branch: "fusion/fn-8923", column: "in-review", workflow: "builtin:coding" };
        }),
        getSettings: vi.fn().mockResolvedValue({ merger: { maxReviewPasses: 0 }, agentPrompts: {} }),
        updateTask,
        logEntry: vi.fn().mockResolvedValue(undefined),
        appendAgentLog: vi.fn().mockResolvedValue(undefined),
      };
      await expect(runAiMerge(store as never, "/tmp/fn-8923", "FN-8923", { signal: controller.signal })).rejects.toBeInstanceOf(Error);
      expect(store.getTask).toHaveBeenCalledWith("FN-8923");
      expect(writesAtAbort).toBe(0);
      const orphanWrites = updateTask.mock.calls.slice(writesAtAbort);
      expect(orphanWrites).not.toContainEqual(["FN-8923", { status: "merging" }]);
      // Execution proof: the real body reached and returned from its task-read seam before abort.
      expect(store.getTask).toHaveBeenCalledOnce();
    });

    it("aborts from the real mid-review seam before orphan finalization writes", async () => {
      const directory = createMergeRepo();
      const controller = new AbortController();
      const { store, records } = createRecordingStore(controller, { sharedGroup: true });
      let recordsAtAbort = -1;
      await expect(runAiMerge(store as never, directory, "FN-8923", { manual: true, signal: controller.signal }, {
        mergeAgent: async (cwd) => { git(cwd, "merge --squash fusion/fn-8923 && git commit -q -m squash"); },
        // This is the abort-at-boundary fixture: review completed, the squash exists, and the
        // production body is about to enter its landing/finalization stretch.
        reviewAgent: async () => {
          controller.abort("orphaned after clean-room review");
          recordsAtAbort = records.length;
          return "REVIEW_VERDICT: approve";
        },
      })).rejects.toMatchObject({ name: "MergeAbortedError" });
      const orphanWrites = records.slice(recordsAtAbort);
      expect(recordsAtAbort).toBeGreaterThanOrEqual(0);
      // Positive writes are their own execution proof and demonstrate that this is a body that
      // outlived its abort rather than a pre-aborted fixture that stopped at an entry checkpoint.
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.updateTask::#1.
      expect(orphanWrites.some(({ writer, args }) => writer === "updateTask" && (args[1] as Record<string, unknown>).mergeDetails)).toBe(false);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/auto-merge-finalization.ts::finalizeProvenAutoMergeTask>moved::store.moveTask::#1.
      expect(orphanWrites.some(({ writer }) => writer === "moveTask")).toBe(false);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::finalizeTask::store.emit::#1.
      expect(orphanWrites.some(({ writer, args }) => writer === "emit" && args[0] === "task:merged")).toBe(false);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.recordBranchGroupMemberLanded::#1.
      expect(orphanWrites.some(({ writer }) => writer === "recordBranchGroupMemberLanded")).toBe(false);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::runAiMerge>log::store.logEntry::#1.
      expect(orphanWrites.some(({ writer }) => writer === "logEntry")).toBe(false);
      expect(orphanWrites.some(({ writer }) => writer === "appendAgentLog")).toBe(false);
    });

    it("attempts the real landOneRepo pre-land boundary", async () => {
      const controller = new AbortController();
      controller.abort("orphaned generation before land");
      const context = { taskId: "FN-8923", settings: {}, audit: undefined, log: vi.fn(), setStatus: vi.fn(), maxPasses: 0, mergeAgent: vi.fn(), reviewAgent: vi.fn(), stashResolveAgent: vi.fn(), includeTaskId: true, trailers: [], taskTitle: "test", signal: controller.signal, store: { getTask: vi.fn() } };
      await expect(landOneRepo("/tmp/fn-8923", "fusion/fn-8923", "main", context as never)).rejects.toThrow(/aborted/i);
      // This only characterizes entry-adjacent abort. The manifest explicitly records deep
      // review/ref-advance/merge-details rows as unobservable rather than treating this as proof.
      expect(context.log).not.toHaveBeenCalled();
    });

    it("aborts from the integration-ref audit seam after the real ref advance", async () => {
      const directory = createMergeRepo();
      const controller = new AbortController();
      const { store, records } = createRecordingStore(controller, {
        sharedGroup: true,
        // `advanceIntegrationBranchRef` emits this durable audit only after its CAS ref write.
        onIntegrationRefAdvance: () => controller.abort("orphaned after integration ref advance"),
      });
      await expect(runAiMerge(store as never, directory, "FN-8923", { manual: true, signal: controller.signal }, {
        mergeAgent: async (cwd) => { git(cwd, "merge --squash fusion/fn-8923 && git commit -q -m squash"); },
        reviewAgent: async () => "REVIEW_VERDICT: approve",
      })).rejects.toMatchObject({ name: "MergeAbortedError" });
      expect(controller.signal.aborted).toBe(true);
      // The post-boundary mergeDetails write proves the production body passed the ref-advance seam.
      expect(records.some(({ writer, args }) => writer === "updateTask" && (args[1] as Record<string, unknown>).mergeDetails)).toBe(false);
    });

    it("aborts from the mergeDetails persistence seam before the private finalization tail", async () => {
      const directory = createMergeRepo();
      const controller = new AbortController();
      const { store, records } = createRecordingStore(controller, {
        sharedGroup: true,
        onMergeDetailsPersist: () => controller.abort("orphaned after mergeDetails persistence"),
      });
      await expect(runAiMerge(store as never, directory, "FN-8923", { manual: true, signal: controller.signal }, {
        mergeAgent: async (cwd) => { git(cwd, "merge --squash fusion/fn-8923 && git commit -q -m squash"); },
        reviewAgent: async () => "REVIEW_VERDICT: approve",
      })).rejects.toMatchObject({ name: "MergeAbortedError" });
      expect(controller.signal.aborted).toBe(true);
      // `task:merged` is emitted after mergeDetails, proving the private tail was reached through runAiMerge.
      expect(records.some(({ writer, args }) => writer === "emit" && args[0] === "task:merged")).toBe(false);
    });

    it("aborts during a real second workspace-repository land and partitions successor writes", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "fn-8923-workspace-"));
      temporaryRepos.add(workspaceRoot);
      const repositories = ["repo-a", "repo-b"].map((name) => {
        const directory = join(workspaceRoot, name);
        git(workspaceRoot, `init -q -b main ${name}`);
        git(directory, "config user.email fn8923@example.test");
        git(directory, "config user.name FN-8923");
        writeFileSync(join(directory, "base.txt"), "base\\n");
        git(directory, "add -A && git commit -q -m base");
        git(directory, "checkout -q -b fusion/fn-8923");
        writeFileSync(join(directory, "feature.txt"), `${name}\\n`);
        git(directory, "add -A && git commit -q -m feature");
        git(directory, "checkout -q main");
        return directory;
      });
      const lane = seedMergeLaneState(Object.create(ProjectEngine.prototype) as ProjectEngine) as unknown as {
        claimActiveMerge(taskId: string): AbortSignal;
        abortActiveMerge(taskId: string, reason: string): boolean;
        trackMergeBody(body: Promise<unknown>): Promise<unknown>;
        awaitPriorMergeBodySettle(): Promise<void>;
        mergeBodySettleTimeoutMs: number;
      };
      lane.mergeBodySettleTimeoutMs = 1;
      const orphanSignal = lane.claimActiveMerge("FN-8923");
      const { store, storeFor, task, records } = createRecordingStore(new AbortController());
      const workspaceWorktrees = Object.fromEntries(repositories.map((directory, index) => [
        `repo-${String.fromCharCode(97 + index)}`,
        // The merge-boundary evidence capture reads each entry's checkout, so the path is required.
        { branch: "fusion/fn-8923", worktreePath: directory },
      ]));
      /*
      FNXC:RepositoryScope 2026-08-23-21:35:
      Landing now refuses a workspace task whose repository scope is unresolved — operator
      confirmation is a precondition, so without it `landWorkspaceTask` rejected before its first
      merge agent ran and this test waited forever on a boundary that could never be reached. This
      is a merge-mechanics fixture with no review episode (no `reviewEvidence`, no enabled review
      step), which is the legacy/direct caller shape that keeps the merge-agent review path.
      */
      Object.assign(task, {
        workspaceWorktrees,
        title: "workspace orphan evidence",
        repositoryScope: { repositories: ["repo-a", "repo-b"], state: "confirmed", revision: 1 },
      });
      let mergeCount = 0;
      let recordCountAtAbort = -1;
      let releaseOrphan!: () => void;
      const orphanHeldAtBoundary = new Promise<void>((resolve) => { releaseOrphan = resolve; });
      let boundaryReached!: () => void;
      const secondLandReached = new Promise<void>((resolve) => { boundaryReached = resolve; });
      const body = landWorkspaceTask(store as never, task as never, workspaceRoot, { signal: orphanSignal }, {
        mergeAgent: async (cwd) => {
          mergeCount += 1;
          git(cwd, "merge --squash fusion/fn-8923 && git commit -q -m squash");
          if (mergeCount === 2) {
            // Keep the real production body pending after its real lane abort so the bounded
            // settle latch can expire before the real successor claim occurs.
            expect(lane.abortActiveMerge("FN-8923", "orphaned during second workspace repository land")).toBe(true);
            recordCountAtAbort = records.length;
            boundaryReached();
            await orphanHeldAtBoundary;
          }
        },
        reviewAgent: async () => "REVIEW_VERDICT: approve",
        stashResolveAgent: vi.fn(),
      });
      lane.trackMergeBody(body);
      await secondLandReached;
      expect(orphanSignal.aborted).toBe(true);

      vi.useFakeTimers();
      const settle = lane.awaitPriorMergeBodySettle();
      await vi.advanceTimersByTimeAsync(1);
      await settle;
      const successorSignal = lane.claimActiveMerge("FN-8923");
      expect(successorSignal).not.toBe(orphanSignal);
      expect(successorSignal.aborted).toBe(false);
      const successorStore = storeFor("successor");
      let releaseSuccessor!: () => void;
      const successorHeldAtSeam = new Promise<void>((resolve) => { releaseSuccessor = resolve; });
      let successorSeamReached!: () => void;
      let successorIsHeldAtProductionSeam = false;
      const successorAtProductionSeam = new Promise<void>((resolve) => { successorSeamReached = resolve; });
      /*
      FNXC:MergeReliability 2026-08-11-00:37:
      Code review requires a live successor workspace body, not merely a fresh signal or a
      labelled status leaf. Hold this production entry point at its merge-agent seam while the
      orphan resumes, so both generations overlap against the same task row.
      */
      const successorBody = landWorkspaceTask(successorStore as never, task as never, workspaceRoot, { signal: successorSignal }, {
        mergeAgent: async (cwd) => {
          successorIsHeldAtProductionSeam = true;
          successorSeamReached();
          await successorHeldAtSeam;
          successorIsHeldAtProductionSeam = false;
          git(cwd, "merge --squash fusion/fn-8923 && git commit -q -m successor-squash");
        },
        reviewAgent: async () => "REVIEW_VERDICT: approve",
        stashResolveAgent: vi.fn(),
      });
      await successorAtProductionSeam;
      expect(successorIsHeldAtProductionSeam).toBe(true);
      releaseOrphan();
      // FNXC:MergeReliability 2026-08-11-00:37: This assertion proves the bodies overlap at a real production seam.
      await expect(body).rejects.toMatchObject({ name: "MergeAbortedError" });
      expect(successorIsHeldAtProductionSeam).toBe(true);
      releaseSuccessor();
      await successorBody;
      expect(mergeCount).toBe(2);
      expect(successorSignal).toBeDefined();
      expect((task.workspaceWorktrees as Record<string, { landedSha?: string }>) ["repo-a"].landedSha).toEqual(expect.any(String));
      const postBoundary = records.slice(recordCountAtAbort);
      const orphanWrites = postBoundary.filter((record) => record.generation === "orphan");
      const successorWrites = postBoundary.filter((record) => record.generation === "successor");
      // FNXC:MergeReliability 2026-08-11-00:37: Separate facades prevent successor writes from satisfying orphan assertions.
      expect(successorWrites).toContainEqual(expect.objectContaining({ writer: "updateTask", args: ["FN-8923", { status: "merging" }] }));
      expect(orphanWrites).not.toContainEqual(expect.objectContaining({ writer: "updateTask", args: ["FN-8923", { status: "merging" }] }));
      expect(orphanWrites.some(({ writer }) => writer === "logEntry")).toBe(false);
    });
  });
});
