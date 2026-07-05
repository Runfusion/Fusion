/**
 * FNXC:PlannerOversight 2026-07-04-19:45:
 * FN-7551 engine-level end-to-end test: proves real overseer decision points
 * — observation, retry, targeted-fix, steering (reviewer), confirmation
 * request, confirmation resolution, and bounded-recovery escalation —
 * populate the `overseer:intervention` run-audit timeline via the ACTUAL
 * production wiring in `project-engine.ts` (`PlannerOverseerMonitor#onObservation`
 * → the private `emitOverseerObservationDeduped`, the private
 * `buildPlannerRecoveryHandlers`, the private `emitOverseerEscalationDeduped`),
 * against a REAL in-memory `TaskStore` — never by calling
 * `emitOverseer*`/`recordPlannerIntervention` directly.
 *
 * Constructing a full `ProjectEngine` (via `start()`) pulls in cron/
 * notification/research/tunnel/automation subsystems that are impractical to
 * boot in a unit test. Instead this file extracts the engine's REAL
 * prototype methods via `Object.create(ProjectEngine.prototype)`, seeding
 * only the two dedup-map instance fields those methods read/write (normally
 * initialized by class-field initializers the constructor never runs here)
 * — this exercises the exact same code that runs inside
 * `pollPlannerOverseer`/`start()` in production, not a reimplementation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, getPlannerInterventionTimeline, type Task } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";
import { PlannerOverseerMonitor, type OverseerStageObservation } from "../planner-overseer.js";
import { PlannerRecoveryController, type PlannerRecoveryHandlers, type PlannerRecoverySnapshotProvider } from "../planner-recovery-controller.js";

interface EngineOverseerInternals {
  plannerObservationEmitDedup: Map<string, string>;
  plannerEscalationEmitDedup: Set<string>;
  buildPlannerRecoveryHandlers(store: TaskStore): PlannerRecoveryHandlers;
  emitOverseerObservationDeduped(store: TaskStore, observation: OverseerStageObservation): void;
  emitOverseerEscalationDeduped(
    store: TaskStore,
    taskId: string,
    decision: { watchedStage: string | null; reason: string; attemptCount: number; attemptLimit: number; sourceLinks: unknown[] },
  ): void;
}

/** Extracts the real `ProjectEngine` prototype methods FN-7551 wired without running its heavy constructor/`start()`. */
function makeEngineInternals(): EngineOverseerInternals {
  const engineLike = Object.create(ProjectEngine.prototype) as unknown as EngineOverseerInternals;
  engineLike.plannerObservationEmitDedup = new Map();
  engineLike.plannerEscalationEmitDedup = new Set();
  return engineLike;
}

/** Builds the real production wiring (monitor + recovery-controller handlers) against a concrete `store`, mirroring `ProjectEngine.start()`. */
function wireRealEngineOverseer(store: TaskStore) {
  const internals = makeEngineInternals();
  const monitor = new PlannerOverseerMonitor({
    store,
    onObservation: (observation) => internals.emitOverseerObservationDeduped(store, observation),
  });
  const handlers = internals.buildPlannerRecoveryHandlers(store);
  const controllerFromMonitor = new PlannerRecoveryController({ snapshotProvider: monitor, handlers });

  return {
    monitor,
    handlers,
    controllerFromMonitor,
    /** A controller wired with the SAME real handlers but a synthetic snapshot, for exercising decision branches the monitor's own signal-derivation cannot produce (e.g. a failed executor signal). */
    controllerWithSnapshot: (observation: OverseerStageObservation) => {
      const provider: PlannerRecoverySnapshotProvider = { getSnapshot: () => observation };
      return new PlannerRecoveryController({ snapshotProvider: provider, handlers });
    },
    emitEscalation: (
      taskId: string,
      decision: { watchedStage: string | null; reason: string; attemptCount: number; attemptLimit: number; sourceLinks: unknown[] },
    ) => internals.emitOverseerEscalationDeduped(store, taskId, decision),
  };
}

function observation(overrides: Partial<OverseerStageObservation> = {}): OverseerStageObservation {
  return {
    taskId: "T",
    stage: "executor",
    signal: "progressing",
    oversightLevel: "autonomous",
    observedAt: Date.now(),
    reason: "test",
    sources: [],
    ...overrides,
  };
}

describe("FN-7551 — overseer decision points populate the intervention timeline via the live wiring", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-7551-engine-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "fn-7551-engine-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(() => {
    store.stopWatching();
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  async function seedTask(column: "in-progress" | "in-review" = "in-progress"): Promise<Task> {
    const task = await store.createTask({ title: "T", description: "d" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    if (column === "in-review") {
      await store.moveTask(task.id, "in-review", { preserveProgress: true } as never);
    }
    return (await store.getTask(task.id))!;
  }

  it("observation: emits exactly one entry per (stage, signal), dedupes an unchanged repeat, and appends on a changed signal", async () => {
    const task = await seedTask("in-progress");
    const { monitor } = wireRealEngineOverseer(store);

    await monitor.observeTask(task, "autonomous");
    await monitor.observeTask(task, "autonomous");
    await monitor.observeTask(task, "autonomous");

    let timeline = getPlannerInterventionTimeline(store, task.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].action).toBe("observe");
    expect(timeline[0].stage).toBe("executor");

    // Change the signal (progressing -> "blocked" via paused) and observe again — must append.
    const pausedTask = { ...task, paused: true, pausedReason: "manual test pause" } as Task;
    await monitor.observeTask(pausedTask, "autonomous");

    timeline = getPlannerInterventionTimeline(store, task.id);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].action).toBe("observe"); // newest-first
  });

  it("level 'off' never records an observation entry", async () => {
    const task = await seedTask("in-progress");
    const { monitor } = wireRealEngineOverseer(store);
    const result = await monitor.observeTask(task, "off");
    expect(result).toBeNull();
    expect(getPlannerInterventionTimeline(store, task.id)).toHaveLength(0);
  });

  it("failed executor with no error source dispatches retry_step and emits a retry entry with attemptCount/attemptLimit", async () => {
    const task = await seedTask("in-progress");
    const { controllerWithSnapshot } = wireRealEngineOverseer(store);
    const controller = controllerWithSnapshot(observation({ taskId: task.id, stage: "executor", signal: "failed", sources: [] }));

    const decision = await controller.tick(task);
    expect(decision?.action).toBe("retry_step");

    const timeline = getPlannerInterventionTimeline(store, task.id);
    const retryEntry = timeline.find((e) => e.action === "retry");
    expect(retryEntry).toBeTruthy();
    expect(retryEntry?.stage).toBe("executor");
    expect(retryEntry?.attemptCount).toBe(1);
    expect(retryEntry?.attemptLimit).toBe(3);
  });

  it("failed executor WITH an error source (failed-check) dispatches request_targeted_fix and emits a request-fix entry", async () => {
    const task = await seedTask("in-progress");
    const { controllerWithSnapshot } = wireRealEngineOverseer(store);
    const controller = controllerWithSnapshot(
      observation({
        taskId: task.id,
        stage: "executor",
        signal: "failed",
        sources: [{ kind: "failed-check", ref: "lint" }],
      }),
    );

    const decision = await controller.tick(task);
    expect(decision?.action).toBe("request_targeted_fix");

    const timeline = getPlannerInterventionTimeline(store, task.id);
    const fixEntry = timeline.find((e) => e.action === "request-fix");
    expect(fixEntry).toBeTruthy();
    expect(fixEntry?.attemptCount).toBe(1);
    expect(fixEntry?.attemptLimit).toBe(3);
    expect(fixEntry?.sourceLinks?.[0]?.target).toBe("lint");
  });

  it("reviewer stage dispatches inject_guidance and emits an inject-guidance steering entry", async () => {
    const task = await seedTask("in-review");
    const { controllerWithSnapshot } = wireRealEngineOverseer(store);
    const controller = controllerWithSnapshot(observation({ taskId: task.id, stage: "reviewer", signal: "progressing" }));

    const decision = await controller.tick(task);
    expect(decision?.action).toBe("inject_guidance");

    const timeline = getPlannerInterventionTimeline(store, task.id);
    const steeringEntry = timeline.find((e) => e.action === "inject-guidance");
    expect(steeringEntry).toBeTruthy();
    expect(steeringEntry?.stage).toBe("reviewer");
  });

  it("merger/pull-request confirmation-required decision emits a request-confirmation entry; approving it emits a resolution entry with 'succeeded'", async () => {
    const task = await seedTask("in-review");
    const { monitor, controllerFromMonitor: controller } = wireRealEngineOverseer(store);
    await monitor.observeTask(task, "autonomous"); // merger stage (plain in-review, no PR/reviewState)

    const decision = await controller.tick(task);
    expect(decision?.requiresConfirmation).toBe(true);

    let timeline = getPlannerInterventionTimeline(store, task.id);
    const requestEntry = timeline.find((e) => e.action === "request-confirmation");
    expect(requestEntry).toBeTruthy();
    expect(requestEntry?.outcome).toBe("awaiting-confirmation");

    const pending = controller.getPendingConfirmations(task.id);
    expect(pending).toHaveLength(1);

    await controller.resolveConfirmation(task.id, pending[0].requestId, "approved", "test-user");

    timeline = getPlannerInterventionTimeline(store, task.id);
    const confirmationEntries = timeline.filter((e) => e.action === "request-confirmation");
    expect(confirmationEntries.length).toBeGreaterThanOrEqual(2);
    expect(confirmationEntries.some((e) => e.outcome === "succeeded")).toBe(true);
  });

  it("denying a confirmation resolution emits a 'skipped' outcome entry", async () => {
    const task = await seedTask("in-review");
    const { monitor, controllerFromMonitor: controller } = wireRealEngineOverseer(store);
    await monitor.observeTask(task, "autonomous");
    await controller.tick(task);
    const pending = controller.getPendingConfirmations(task.id);
    expect(pending).toHaveLength(1);

    await controller.resolveConfirmation(task.id, pending[0].requestId, "denied");

    const timeline = getPlannerInterventionTimeline(store, task.id);
    const confirmationEntries = timeline.filter((e) => e.action === "request-confirmation");
    expect(confirmationEntries.some((e) => e.outcome === "skipped")).toBe(true);
  });

  it("bounded-recovery exhaustion emits exactly one escalate entry across repeated polls of the same exhausted stage", async () => {
    const task = await seedTask("in-progress");
    const { emitEscalation } = wireRealEngineOverseer(store);
    const exhaustedDecision = {
      watchedStage: "executor",
      reason: 'Bounded recovery attempt budget (3) exhausted for stage "executor"',
      attemptCount: 3,
      attemptLimit: 3,
      sourceLinks: [],
    };

    emitEscalation(task.id, exhaustedDecision);
    emitEscalation(task.id, exhaustedDecision);
    emitEscalation(task.id, exhaustedDecision);

    const timeline = getPlannerInterventionTimeline(store, task.id);
    const escalations = timeline.filter((e) => e.action === "escalate");
    expect(escalations).toHaveLength(1);
    expect(escalations[0].outcome).toBe("failed");
  });

  it("exhaustion actually reached through real tick()s (three denials) emits escalate exactly once thereafter", async () => {
    const task = await seedTask("in-review");
    const { monitor, controllerFromMonitor: controller, emitEscalation } = wireRealEngineOverseer(store);
    await monitor.observeTask(task, "autonomous");

    for (let i = 0; i < 3; i += 1) {
      const decision = await controller.tick(task);
      expect(decision?.requiresConfirmation).toBe(true);
      const pending = controller.getPendingConfirmations(task.id);
      await controller.resolveConfirmation(task.id, pending[0].requestId, "denied");
    }

    const finalDecision = await controller.tick(task);
    expect(finalDecision?.action).toBe("none");
    expect(finalDecision?.exhausted).toBe(true);

    // The poll wires escalation emission itself (project-engine.ts), so drive
    // it explicitly here with the real decision object, twice, to prove the dedup.
    emitEscalation(task.id, finalDecision!);
    emitEscalation(task.id, finalDecision!);

    const timeline = getPlannerInterventionTimeline(store, task.id);
    expect(timeline.filter((e) => e.action === "escalate")).toHaveLength(1);
  });

  it("oversight level 'off' and a human-control-withheld (userPaused) task never emit any steering/retry/fix/confirmation/escalation entry", async () => {
    const task = await seedTask("in-review");
    const { monitor, controllerFromMonitor: controller } = wireRealEngineOverseer(store);

    // Level "off": monitor records nothing (mirrors the poll's `continue` before ever calling tick()).
    const result = await monitor.observeTask(task, "off");
    expect(result).toBeNull();
    expect(getPlannerInterventionTimeline(store, task.id)).toHaveLength(0);

    // Human-control withheld (userPaused) — tick() must short-circuit before
    // any confirmation classification/dispatch, so no intervention entry is
    // ever recorded (the withhold itself is a separate no-action event this
    // task does not touch).
    const pausedTask = { ...task, userPaused: true } as Task;
    const decision = await controller.tick(pausedTask);
    expect(decision).toBeNull();
    expect(getPlannerInterventionTimeline(store, task.id)).toHaveLength(0);
  });

  it("a store/façade failure during observation emission never throws out of observeTask (best-effort contract)", async () => {
    const task = await seedTask("in-progress");
    const throwingStore = {
      ...store,
      recordRunAuditEvent: () => {
        throw new Error("boom");
      },
    } as unknown as TaskStore;

    const { monitor } = wireRealEngineOverseer(throwingStore);
    await expect(monitor.observeTask(task, "autonomous")).resolves.not.toThrow();
  });
});
