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

/** A real clean-room-sized repository so an abort can land during the production merge tail. */
function createMergeRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "fn-8923-merge-"));
  temporaryRepos.add(directory);
  git(directory, "init -q -b main");
  git(directory, "config user.email fn8923@example.test");
  git(directory, "config user.name FN-8923");
  writeFileSync(join(directory, "base.txt"), "base\\n");
  git(directory, "add -A && git commit -q -m base");
  git(directory, "checkout -q -b fusion/FN-8923");
  writeFileSync(join(directory, "feature.txt"), "feature\\n");
  git(directory, "add -A && git commit -q -m feature");
  git(directory, "branch group-main main");
  git(directory, "checkout -q main");
  return directory;
}

function createRecordingStore(controller: AbortController, options: { sharedGroup?: boolean; onMergeDetailsPersist?: () => void; onIntegrationRefAdvance?: () => void } = {}) {
  const task: Record<string, unknown> = {
    id: "FN-8923", column: "in-review", status: null, branch: "fusion/FN-8923", title: "orphan evidence", steps: [],
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
          return { id: "FN-8923", branch: "fusion/FN-8923", column: "in-review", workflow: "builtin:coding" };
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

    it("aborts from the real mid-review seam and records orphan finalization writes", async () => {
      const directory = createMergeRepo();
      const controller = new AbortController();
      const { store, records } = createRecordingStore(controller, { sharedGroup: true });
      let recordsAtAbort = -1;
      const result = await runAiMerge(store as never, directory, "FN-8923", { manual: true, signal: controller.signal }, {
        mergeAgent: async (cwd) => { git(cwd, "merge --squash fusion/FN-8923 && git commit -q -m squash"); },
        // This is the abort-at-boundary fixture: review completed, the squash exists, and the
        // production body is about to enter its landing/finalization stretch.
        reviewAgent: async () => {
          controller.abort("orphaned after clean-room review");
          recordsAtAbort = records.length;
          return "REVIEW_VERDICT: approve";
        },
      });
      const orphanWrites = records.slice(recordsAtAbort);
      expect(recordsAtAbort).toBeGreaterThanOrEqual(0);
      expect(result.merged).toBe(true);
      // Positive writes are their own execution proof and demonstrate that this is a body that
      // outlived its abort rather than a pre-aborted fixture that stopped at an entry checkpoint.
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.updateTask::#1.
      expect(orphanWrites.some(({ writer, args }) => writer === "updateTask" && (args[1] as Record<string, unknown>).mergeDetails)).toBe(true);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/auto-merge-finalization.ts::finalizeProvenAutoMergeTask>moved::store.moveTask::#1.
      expect(orphanWrites.some(({ writer }) => writer === "moveTask")).toBe(true);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::finalizeTask::store.emit::#1.
      expect(orphanWrites.some(({ writer, args }) => writer === "emit" && args[0] === "task:merged")).toBe(true);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::finalizeMerged::store.recordBranchGroupMemberLanded::#1.
      expect(orphanWrites.some(({ writer }) => writer === "recordBranchGroupMemberLanded")).toBe(true);
      // FN-8923 follow-up: FN-8958 flips packages/engine/src/merge/merger-ai.ts::runAiMerge>log::store.logEntry::#1.
      expect(orphanWrites.some(({ writer }) => writer === "logEntry")).toBe(true);
      expect(orphanWrites.some(({ writer }) => writer === "appendAgentLog")).toBe(true);
    });

    it("attempts the real landOneRepo pre-land boundary", async () => {
      const controller = new AbortController();
      controller.abort("orphaned generation before land");
      const context = { taskId: "FN-8923", settings: {}, audit: undefined, log: vi.fn(), setStatus: vi.fn(), maxPasses: 0, mergeAgent: vi.fn(), reviewAgent: vi.fn(), stashResolveAgent: vi.fn(), includeTaskId: true, trailers: [], taskTitle: "test", signal: controller.signal, store: { getTask: vi.fn() } };
      await expect(landOneRepo("/tmp/fn-8923", "fusion/FN-8923", "main", context as never)).rejects.toThrow(/aborted/i);
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
      const result = await runAiMerge(store as never, directory, "FN-8923", { manual: true, signal: controller.signal }, {
        mergeAgent: async (cwd) => { git(cwd, "merge --squash fusion/FN-8923 && git commit -q -m squash"); },
        reviewAgent: async () => "REVIEW_VERDICT: approve",
      });
      expect(controller.signal.aborted).toBe(true);
      expect(result.merged).toBe(true);
      // The post-boundary mergeDetails write proves the production body passed the ref-advance seam.
      expect(records.some(({ writer, args }) => writer === "updateTask" && (args[1] as Record<string, unknown>).mergeDetails)).toBe(true);
    });

    it("aborts from the mergeDetails persistence seam before the private finalization tail", async () => {
      const directory = createMergeRepo();
      const controller = new AbortController();
      const { store, records } = createRecordingStore(controller, {
        sharedGroup: true,
        onMergeDetailsPersist: () => controller.abort("orphaned after mergeDetails persistence"),
      });
      const result = await runAiMerge(store as never, directory, "FN-8923", { manual: true, signal: controller.signal }, {
        mergeAgent: async (cwd) => { git(cwd, "merge --squash fusion/FN-8923 && git commit -q -m squash"); },
        reviewAgent: async () => "REVIEW_VERDICT: approve",
      });
      expect(controller.signal.aborted).toBe(true);
      expect(result.merged).toBe(true);
      // `task:merged` is emitted after mergeDetails, proving the private tail was reached through runAiMerge.
      expect(records.some(({ writer, args }) => writer === "emit" && args[0] === "task:merged")).toBe(true);
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
        git(directory, "checkout -q -b fusion/FN-8923");
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
      const workspaceWorktrees = Object.fromEntries(repositories.map((_, index) => [`repo-${String.fromCharCode(97 + index)}`, { branch: "fusion/FN-8923" }]));
      Object.assign(task, { workspaceWorktrees, title: "workspace orphan evidence" });
      let mergeCount = 0;
      let recordCountAtAbort = -1;
      let releaseOrphan!: () => void;
      const orphanHeldAtBoundary = new Promise<void>((resolve) => { releaseOrphan = resolve; });
      let boundaryReached!: () => void;
      const secondLandReached = new Promise<void>((resolve) => { boundaryReached = resolve; });
      const body = landWorkspaceTask(store as never, task as never, workspaceRoot, { signal: orphanSignal }, {
        mergeAgent: async (cwd) => {
          mergeCount += 1;
          git(cwd, "merge --squash fusion/FN-8923 && git commit -q -m squash");
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
          git(cwd, "merge --squash fusion/FN-8923 && git commit -q -m successor-squash");
        },
        reviewAgent: async () => "REVIEW_VERDICT: approve",
        stashResolveAgent: vi.fn(),
      });
      await successorAtProductionSeam;
      expect(successorIsHeldAtProductionSeam).toBe(true);
      releaseOrphan();
      // FNXC:MergeReliability 2026-08-11-00:37: This assertion proves the bodies overlap at a real production seam.
      const result = await body;
      expect(successorIsHeldAtProductionSeam).toBe(true);
      releaseSuccessor();
      await successorBody;
      expect(mergeCount).toBe(2);
      expect(successorSignal).toBeDefined();
      expect(result.repos[0]).toMatchObject({ repo: "repo-a", status: "landed" });
      expect((task.workspaceWorktrees as Record<string, { landedSha?: string }>) ["repo-a"].landedSha).toEqual(expect.any(String));
      const postBoundary = records.slice(recordCountAtAbort);
      const orphanWrites = postBoundary.filter((record) => record.generation === "orphan");
      const successorWrites = postBoundary.filter((record) => record.generation === "successor");
      // FNXC:MergeReliability 2026-08-11-00:37: Separate facades prevent successor writes from satisfying orphan assertions.
      expect(successorWrites).toContainEqual(expect.objectContaining({ writer: "updateTask", args: ["FN-8923", { status: "merging" }] }));
      expect(orphanWrites).not.toContainEqual(expect.objectContaining({ writer: "updateTask", args: ["FN-8923", { status: "merging" }] }));
      expect(orphanWrites.some(({ writer }) => writer === "logEntry")).toBe(true);
    });
  });
});
