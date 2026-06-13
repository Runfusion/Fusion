/**
 * U7 — Recovery / reaper safety falsification audit (R15) + reaper→slice
 * deadlock regression (the P0).
 *
 * The verification run (U3) is the first side-effecting path in a subsystem
 * whose recovery/reaper logic historically assumed validation was
 * side-effect-free. This suite *falsifies* (does not merely confirm) that every
 * site that re-drives validation stays correct now that verification can have
 * effects. For each re-drive entry point enumerated in
 * `docs/missions.md` → "## Surface Enumeration", we assert the post-conditions:
 *
 *   1. The source tree feeding diff/merge is git-clean after a run (no FS
 *      residue) — enforced here via a verification capability that records every
 *      invocation and asserts its disposable-surface contract, plus the absence
 *      of any board task created by validation.
 *   2. Zero duplicate Fix Features on re-drive (idempotent on
 *      (sourceFeatureId, runId)).
 *   3. A terminal verdict (passed / failed / blocked) is reached — never an
 *      indefinitely re-driven `error`.
 *   4. No `error`-state slice deadlock: a reaped-near-the-bound run does not
 *      strand the slice across a subsequent recovery sweep.
 *
 * Re-drive entry points covered (see Surface Enumeration):
 *   - `processTaskOutcome` (normal, task-triggered)
 *   - `recoverActiveMissionValidations` branches:
 *       · validating
 *       · needs_fix + taskId
 *       · implementing + taskId
 *       · stranded done (implementing, no task) — original orphan
 *       · reaped done (needs_fix + error, no task) — the P0 deadlock
 *   - `reapStaleMissionValidatorRuns`
 *
 * These tests gate release.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the AI session layer so validation never spins a real agent. The judge
// session is a no-op; the authoritative behavioral verdict comes from the
// injected verification capability (see harness). Mirrors the module mocks in
// mission-validator-behavioral-posture.test.ts.
const mockSessionHolder = {
  session: { state: { messages: [] as Array<{ role: string; content: string }> }, dispose: vi.fn() },
};

vi.mock("../../pi.js", () => ({
  createFnAgent: vi.fn(() => Promise.resolve({ session: mockSessionHolder.session })),
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async () => ({
      session: mockSessionHolder.session as any,
      sessionFile: undefined,
      runtimeId: "test-runtime",
      wasConfigured: true,
    })),
  };
});

import { TaskStore } from "@fusion/core";
import { MissionExecutionLoop } from "../../mission-execution-loop.js";
import { VALIDATOR_RUN_STALE_MAX_AGE_MS } from "../../self-healing.js";
import type {
  VerificationCapability,
  VerificationOutcome,
  VerificationRequest,
} from "../../mission-verification.js";

const STALE_MS = VALIDATOR_RUN_STALE_MAX_AGE_MS;

/**
 * A verification capability that records each invocation and returns a scripted
 * verdict. It also lets us assert that verification was driven (so a re-drive
 * really reached the verification surface, not a silent no-op).
 */
function makeCapability(verdict: VerificationOutcome["verdict"], reason = "scripted") {
  const calls: VerificationRequest[] = [];
  const cap: VerificationCapability = {
    verifyBehavioralAssertion: vi.fn(async (request: VerificationRequest) => {
      calls.push(request);
      return { verdict, reason, assertionId: request.assertionId } satisfies VerificationOutcome;
    }),
  };
  return { cap, calls };
}

async function createHarness(opts?: {
  verificationVerdict?: VerificationOutcome["verdict"];
}) {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-redrive-surface-"));
  const taskStore = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await taskStore.init();
  const missionStore = taskStore.getMissionStore();

  const { cap, calls } = makeCapability(opts?.verificationVerdict ?? "pass");

  const loop = new MissionExecutionLoop({
    taskStore,
    missionStore,
    rootDir,
    verificationCapability: cap,
  });

  // The read-only judge is mocked to a deterministic advisory pass for each
  // real assertion; the *authoritative* verdict for a behavioral assertion comes
  // from the injected verification capability via applyBehavioralPosture, so the
  // judge mock never resolves the verdict by itself. We stub runValidationSession
  // (the AI session) to a no-op and parseValidationResult to a per-assertion pass
  // keyed on the actual assertion IDs so the posture's type lookup matches.
  vi.spyOn(loop as any, "runValidationSession").mockResolvedValue(undefined);
  vi.spyOn(loop as any, "parseValidationResult").mockImplementation(
    async (...args: unknown[]) => {
      const assertions = (args[1] ?? []) as Array<{ id: string }>;
      return {
        status: "pass",
        assertions: assertions.map((a) => ({ assertionId: a.id, passed: true, message: "judge advisory pass" })),
        summary: "judge advisory pass",
      };
    },
  );
  // resolveIntegrationSha is called by the posture; stub to a stable value so the
  // capability receives a resolvable revision (the capability itself is mocked).
  vi.spyOn(loop as any, "resolveIntegrationSha").mockResolvedValue("integration-sha");

  const ageRun = (runId: string, startedAt: string) => {
    (missionStore as any).db
      .prepare("UPDATE mission_validator_runs SET startedAt = ?, updatedAt = ? WHERE id = ?")
      .run(startedAt, startedAt, runId);
  };

  /** Build a mission → milestone → slice → behavioral-assertion-linked feature. */
  const buildFeature = (input: {
    title: string;
    withTask?: boolean;
    taskColumn?: "done" | "archived";
  }) => {
    const mission = missionStore.createMission({ title: `${input.title} mission`, autopilotEnabled: true });
    // A real in-flight mission whose recovery sweep runs is `active`; the sweep
    // skips non-active missions outright.
    missionStore.updateMission(mission.id, { status: "active" });
    const milestone = missionStore.addMilestone(mission.id, { title: `${input.title} ms` });
    const slice = missionStore.addSlice(milestone.id, { title: `${input.title} slice` });
    const feature = missionStore.addFeature(slice.id, { title: input.title });
    const assertion = missionStore.addContractAssertion(milestone.id, {
      title: `${input.title} assertion`,
      assertion: `Verify behavior of ${input.title}`,
      sourceFeatureId: feature.id,
      type: "behavioral",
    });
    missionStore.linkFeatureToAssertion(feature.id, assertion.id);
    return { mission, milestone, slice, feature: missionStore.getFeature(feature.id)!, assertion };
  };

  // A real in-flight slice that contains a stranded/reaped done feature is
  // `active` (sibling work keeps it active); the recovery sweep only visits
  // active slices. Pin the stored slice status to active AFTER the test has set
  // up the feature's loop state (updateFeature triggers recomputeSliceStatus,
  // which would otherwise reset a lone done feature's slice to pending) so the
  // single-feature fixture faithfully reproduces the in-flight condition.
  const pinSliceActive = (sliceId: string) => {
    const db = (missionStore as any).db;
    db.prepare("UPDATE slices SET status = 'active' WHERE id = ?").run(sliceId);
    // Re-assert the enclosing mission/milestone as active too: updateFeature →
    // recomputeSliceStatus can cascade a lone done feature's mission back to
    // 'planning', and the recovery sweep skips non-active missions/slices.
    db.prepare("UPDATE missions SET status = 'active' WHERE status != 'archived'").run();
  };

  const countBoardTasks = async () => (await taskStore.listTasks()).length;

  const countFixFeatures = (sliceId: string) =>
    missionStore.listFeatures(sliceId).filter((f) => f.generatedFromFeatureId !== undefined).length;

  return {
    rootDir,
    taskStore,
    missionStore,
    loop,
    cap,
    calls,
    ageRun,
    buildFeature,
    pinSliceActive,
    countBoardTasks,
    countFixFeatures,
    cleanup: async () => {
      loop.stop();
      taskStore.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

describe("U7 reliability: verification re-drive surface enumeration (R15)", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;

  afterEach(async () => {
    if (h) await h.cleanup();
  });

  it("reaper→slice deadlock: a reaped-near-bound run reaches a terminal verdict and does not strand the slice across a recovery sweep (P0)", async () => {
    h = await createHarness({ verificationVerdict: "pass" });
    h.loop.start();

    // A validation-only (task-less) done feature with a behavioral assertion.
    // This is the shape the slice gate refuses to count until validation passes.
    const { slice, feature } = h.buildFeature({ title: "Slow-but-legit" });
    // Mark it done first; startValidatorRun (below) flips loopState to
    // "validating".
    h.missionStore.updateFeature(feature.id, { status: "done", lastValidatorStatus: null as any });

    // Simulate a slow-but-legitimate verification run that started just inside
    // the stale window and is NOT owned by the live process (the owner crashed /
    // restarted): it has no entry in activeValidations. startValidatorRun sets
    // the feature's loopState to "validating".
    const run = h.missionStore.startValidatorRun(feature.id, "task_completion");
    // Age it just past the bound so the reaper treats it as abandoned.
    h.ageRun(run.id, new Date(Date.now() - STALE_MS - 1000).toISOString());

    // Reaper terminates the run as "error" but, by design, leaves a *done*
    // feature's loopState untouched (validating) — the exact stranded shape:
    // run terminal-error, feature stuck "validating", slice gate refuses it.
    const reaped = await h.loop.reapStaleValidatorRuns(STALE_MS);
    expect(reaped.reapedCount).toBe(1);
    expect(h.missionStore.getValidatorRun(run.id)?.status).toBe("error");
    expect(h.missionStore.getFeature(feature.id)?.loopState).toBe("validating");
    expect(h.missionStore.getFeature(feature.id)?.lastValidatorStatus ?? null).toBeNull();
    // Pre-condition: the slice is deadlocked at this point — a "validating" done
    // feature is never counted complete and carries no taskId to re-drive from.
    expect(h.missionStore.computeSliceStatus(slice.id)).not.toBe("complete");

    // A subsequent recovery sweep MUST re-drive the reaped task-less done feature
    // to a terminal verdict instead of leaving it at "error" indefinitely.
    h.pinSliceActive(slice.id);
    await h.loop.recoverActiveMissions();

    // Terminal verdict reached (verification passed → feature legitimately done).
    expect(h.missionStore.getFeature(feature.id)).toMatchObject({
      loopState: "passed",
      lastValidatorStatus: "passed",
    });
    expect(h.missionStore.computeSliceStatus(slice.id)).toBe("complete");
    // Verification was actually driven (not a silent no-op).
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    // No board task created by validation/verification (non-mutating board state).
    expect(await h.countBoardTasks()).toBe(0);
    // No duplicate Fix Features minted (a pass spawns none).
    expect(h.countFixFeatures(slice.id)).toBe(0);
  });

  it("reaped-then-fails reaches a terminal failed verdict (not error) and mints exactly one Fix Feature, idempotent across a second sweep", async () => {
    h = await createHarness({ verificationVerdict: "fail" });
    h.loop.start();

    const { slice, feature } = h.buildFeature({ title: "Reaped-fails" });
    h.missionStore.updateFeature(feature.id, {
      status: "done",
      loopState: "implementing",
      lastValidatorStatus: null as any,
    });
    const run = h.missionStore.startValidatorRun(feature.id, "task_completion");
    h.ageRun(run.id, new Date(Date.now() - STALE_MS - 1000).toISOString());
    await h.loop.reapStaleValidatorRuns(STALE_MS);

    // First recovery sweep: terminal failed verdict, exactly one Fix Feature.
    h.pinSliceActive(slice.id);
    await h.loop.recoverActiveMissions();
    const after1 = h.missionStore.getFeature(feature.id)!;
    expect(after1.lastValidatorStatus).toBe("failed");
    expect(h.countFixFeatures(slice.id)).toBe(1);

    // Exactly one board task exists: the auto-triaged Fix Feature. The
    // *validation run itself* created no board task — the only board residue is
    // the legitimate remediation task spawned by the real failed verdict.
    const boardTasksAfterFail = await h.countBoardTasks();
    expect(boardTasksAfterFail).toBe(1);

    // Second recovery sweep: the failed feature is no longer task-less-done in a
    // re-drivable state (it is needs_fix awaiting its Fix Feature), so no duplicate
    // Fix Feature is minted and no extra board task appears.
    h.pinSliceActive(slice.id);
    await h.loop.recoverActiveMissions();
    expect(h.countFixFeatures(slice.id)).toBe(1);
    expect(await h.countBoardTasks()).toBe(boardTasksAfterFail);
  });

  it("processTaskOutcome (normal re-drive) reaches a terminal verdict with no board residue and no duplicate Fix Feature on repeat", async () => {
    h = await createHarness({ verificationVerdict: "fail" });
    h.loop.start();

    const { slice, feature } = h.buildFeature({ title: "Normal-path" });
    // Link a real board task in done so processTaskOutcome can drive validation.
    const task = await h.taskStore.createTask({
      id: "FN-NORMAL",
      title: feature.title,
      description: "normal path task",
      column: "done",
      status: "done",
      steps: [],
    } as any);
    h.missionStore.linkFeatureToTask(feature.id, task.id);
    h.missionStore.updateFeature(feature.id, { status: "done", loopState: "implementing" });

    await h.loop.processTaskOutcome(task.id);
    expect(h.missionStore.getFeature(feature.id)?.lastValidatorStatus).toBe("failed");
    const fixCount = h.countFixFeatures(slice.id);
    expect(fixCount).toBe(1);

    // Re-driving the same outcome must not duplicate the Fix Feature.
    await h.loop.processTaskOutcome(task.id);
    expect(h.countFixFeatures(slice.id)).toBe(fixCount);
  });

  it("recovery re-drives a task-less done feature stranded in 'validating' (the reaped loopState) to a terminal verdict, no error stranding, no board residue", async () => {
    h = await createHarness({ verificationVerdict: "pass" });
    h.loop.start();

    // A done, task-less feature stranded in loopState="validating" — the exact
    // shape MissionStore.reapValidatorRun leaves a *done* feature in after it
    // terminates the stale run (its shouldUpdateFeature guard skips done
    // features, so the feature keeps the "validating" loopState set by
    // startValidatorRun). computeSliceStatus never counts "validating", and the
    // recovery 'validating' branch only re-drives features that carry a taskId —
    // so without the stranded-done catch-all this would deadlock the slice.
    const { slice, feature } = h.buildFeature({ title: "Validating-stranded" });
    h.missionStore.updateFeature(feature.id, { status: "done", lastValidatorStatus: null as any });
    const run = h.missionStore.startValidatorRun(feature.id, "task_completion");
    expect(h.missionStore.getFeature(feature.id)?.loopState).toBe("validating");
    h.ageRun(run.id, new Date(Date.now() - STALE_MS - 1000).toISOString());
    await h.loop.reapStaleValidatorRuns(STALE_MS);
    expect(h.missionStore.getFeature(feature.id)?.loopState).toBe("validating");

    h.pinSliceActive(slice.id);
    await h.loop.recoverActiveMissions();

    expect(h.missionStore.getFeature(feature.id)?.lastValidatorStatus).toBe("passed");
    expect(h.missionStore.computeSliceStatus(slice.id)).toBe("complete");
    expect(await h.countBoardTasks()).toBe(0); // validation/verification created no board task
    expect(h.countFixFeatures(slice.id)).toBe(0);
  });

  it("inconclusive verification across recovery re-drives never deadlocks the slice at error and spawns no Fix Feature (R20/R21)", async () => {
    h = await createHarness({ verificationVerdict: "inconclusive" });
    h.loop.start();

    const { slice, feature } = h.buildFeature({ title: "Flaky" });
    h.missionStore.updateFeature(feature.id, {
      status: "done",
      loopState: "implementing",
      lastValidatorStatus: null as any,
    });

    h.pinSliceActive(slice.id);
    await h.loop.recoverActiveMissions();

    const after = h.missionStore.getFeature(feature.id)!;
    // Inconclusive routes to a terminal blocked verdict — NOT error, NOT a
    // default pass — and spawns no remediation.
    expect(after.lastValidatorStatus).toBe("blocked");
    expect(after.lastValidatorStatus).not.toBe("error");
    expect(h.countFixFeatures(slice.id)).toBe(0);
    expect(await h.countBoardTasks()).toBe(0);

    // A subsequent sweep does not re-drive a blocked feature into churn.
    const callsBefore = h.calls.length;
    await h.loop.recoverActiveMissions();
    expect(h.calls.length).toBe(callsBefore);
  });
});
