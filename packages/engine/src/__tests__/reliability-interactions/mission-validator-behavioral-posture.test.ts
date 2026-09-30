/**
 * Behavioral-verification posture in the Validator Run (U2 + U3).
 *
 * Verifies the default-to-fail posture for behavioral assertions and the
 * non-mutating verification step that confirms them, while static assertions
 * keep the exact legacy judge path.
 *
 * Covers:
 * - AE2: behavioral assertion with no verification evidence → fail, even when
 *   the judge text claims pass (capability absent).
 * - AE3: static assertion → unchanged static verdict, no verification invoked.
 * - Mixed set: static and behavioral each take their correct path.
 * - Behavioral pass via an injected verification capability.
 * - Behavioral inconclusive → blocked verdict, NO fix feature.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  Mission,
  Milestone,
  Slice,
  MissionFeature,
  MissionValidatorRun,
} from "@fusion/core";
import type { VerificationCapability, VerificationOutcome } from "../../missions/mission-verification.js";

// ── Mock AI dependencies (mirror mission-execution-loop.test.ts) ───────────────
const mockSessionHolder: {
  session: { state: { messages: Array<{ role: string; content: string }> }; dispose: ReturnType<typeof vi.fn> };
} = { session: { state: { messages: [] }, dispose: vi.fn() } };

vi.mock("../../pi.js", () => ({
  createFnAgent: vi.fn(() => Promise.resolve({ session: mockSessionHolder.session })),
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../logger.js", () => ({
  createLogger: vi.fn(() => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock("../../agents/agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-session-helpers.js")>();
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

import { createResolvedAgentSession } from "../../agents/agent-session-helpers.js";
import { MissionExecutionLoop } from "../../missions/mission-execution-loop.js";

type AssertionRow = {
  id: string;
  milestoneId: string;
  title: string;
  assertion: string;
  status: "pending" | "passed" | "failed" | "blocked";
  type?: "static" | "behavioral";
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
  sourceFeatureId?: string;
};

function now() {
  return new Date().toISOString();
}

function createMockMission(): Mission {
  return {
    id: "M-TEST1",
    title: "Test Mission",
    status: "active",
    interviewState: "not_started",
    autopilotEnabled: true,
    autopilotState: "inactive",
    createdAt: now(),
    updatedAt: now(),
  };
}

function createMockMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "MS-001",
    missionId: "M-TEST1",
    title: "Test Milestone",
    status: "active",
    orderIndex: 0,
    interviewState: "not_started",
    dependencies: [],
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function createMockSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: "SL-001",
    milestoneId: "MS-001",
    title: "Test Slice",
    status: "active",
    planState: "not_started",
    orderIndex: 0,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function createMockFeature(overrides: Partial<MissionFeature> = {}): MissionFeature {
  return {
    id: "F-001",
    sliceId: "SL-001",
    title: "Test Feature",
    status: "defined",
    loopState: "idle",
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function createMockMissionStore() {
  const missions = new Map<string, Mission>();
  const features = new Map<string, MissionFeature>();
  const assertionsByFeature = new Map<string, AssertionRow[]>();
  const validatorRuns = new Map<string, MissionValidatorRun>();
  let completionApplied = true;
  let runSeq = 0;

  const store = {
    getMission: vi.fn((id: string) => missions.get(id)),
    logMissionEvent: vi.fn(),
    getFeature: vi.fn((id: string) => features.get(id)),
    getFeatureByTaskId: vi.fn((taskId: string) => {
      for (const f of features.values()) if (f.taskId === taskId) return f;
      return undefined;
    }),
    updateFeatureStatus: vi.fn((id: string, status: MissionFeature["status"]) => {
      const f = features.get(id)!;
      const updated = { ...f, status, updatedAt: now() };
      features.set(id, updated);
      return updated;
    }),
    listAssertionsForFeature: vi.fn((featureId: string) => assertionsByFeature.get(featureId) ?? []),
    ensureFeatureAssertionLinked: vi.fn((featureId: string) => assertionsByFeature.get(featureId) ?? []),
    getSlice: vi.fn((id: string) => createMockSlice({ id })),
    getMilestone: vi.fn((id: string) => createMockMilestone({ id })),
    startValidatorRun: vi.fn((featureId: string) => {
      const run: MissionValidatorRun = {
        id: `VR-${++runSeq}`,
        featureId,
        milestoneId: "MS-001",
        sliceId: "SL-001",
        status: "running",
        triggerType: "task_completion",
        implementationAttempt: 1,
        validatorAttempt: 1,
        startedAt: now(),
        createdAt: now(),
        updatedAt: now(),
      };
      validatorRuns.set(run.id, run);
      return run;
    }),
    getValidatorRun: vi.fn((id: string) => validatorRuns.get(id)),
    /*
    FNXC:ValidatorCompletionEffects 2026-09-29-11:04:
    Validator completion is an atomic outcome plus effects contract. The production loop proceeds
    only when the store confirms completionApplied, so this shared fake must return that observable
    result and retain the effects payload for every pass, failure, and inconclusive assertion.
    */
    completeValidatorRun: vi.fn((id: string, status: MissionValidatorRun["status"], summary?: string, _legacy?: undefined, effects?: import("@fusion/core").ValidatorRunCompletionEffects) => {
      const run = validatorRuns.get(id)!;
      if (!completionApplied) return { completionApplied: false, run };

      const updated = { ...run, status, summary, completedAt: now(), updatedAt: now(), completionEffects: effects };
      validatorRuns.set(id, updated);
      const feature = features.get(run.featureId);
      if (feature) {
        const loopState = status === "passed" ? "passed" : status === "failed" ? "needs_fix" : status === "blocked" ? "blocked" : "validating";
        features.set(run.featureId, { ...feature, loopState: loopState as any, lastValidatorStatus: status, updatedAt: now() });
      }
      for (const verdict of effects?.assertions ?? []) {
        const assertion = assertionsByFeature.get(run.featureId)?.find((entry) => entry.id === verdict.assertionId);
        if (assertion) assertion.status = verdict.status;
      }
      return { completionApplied: true, run: updated };
    }),
    recordValidatorFailures: vi.fn(() => []),
    createGeneratedFixFeature: vi.fn((sourceFeatureId: string, runId: string) => {
      const src = features.get(sourceFeatureId)!;
      const fix = createMockFeature({ id: `FIX-${sourceFeatureId}`, taskId: `TASK-FIX-${sourceFeatureId}`, generatedFromFeatureId: sourceFeatureId, generatedFromRunId: runId, loopState: "implementing" });
      features.set(fix.id, fix);
      features.set(sourceFeatureId, { ...src, loopState: "implementing", implementationAttemptCount: (src.implementationAttemptCount ?? 0) + 1, updatedAt: now() });
      return fix;
    }),
    triageFeature: vi.fn(async (featureId: string) => {
      const f = features.get(featureId)!;
      const updated = { ...f, status: "triaged" as const, updatedAt: now() };
      features.set(featureId, updated);
      return updated;
    }),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    _setMission: (m: Mission) => missions.set(m.id, m),
    _setFeature: (f: MissionFeature) => features.set(f.id, f),
    _setAssertions: (featureId: string, rows: AssertionRow[]) => assertionsByFeature.set(featureId, rows),
    _setCompletionApplied: (applied: boolean) => { completionApplied = applied; },
  };
  return store;
}

function createMockTaskStore() {
  const tasks = new Map<string, any>();
  return {
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    moveTask: vi.fn(async () => {}),
    updateTask: vi.fn(async () => {}),
    getSettings: vi.fn().mockResolvedValue({ missionStaleThresholdMs: 600_000, missionMaxTaskRetries: 3 }),
    recordRunAuditEvent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    _setTask: (t: any) => tasks.set(t.id, t),
  };
}

function assertionRow(overrides: Partial<AssertionRow> & { id: string }): AssertionRow {
  return {
    milestoneId: "MS-001",
    title: overrides.id,
    assertion: `do ${overrides.id}`,
    status: "pending",
    orderIndex: 0,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

describe("Validator behavioral posture (U2 + U3)", () => {
  let missionStore: ReturnType<typeof createMockMissionStore>;
  let taskStore: ReturnType<typeof createMockTaskStore>;
  let loop: MissionExecutionLoop;

  beforeEach(() => {
    missionStore = createMockMissionStore();
    taskStore = createMockTaskStore();
    vi.mocked(createResolvedAgentSession).mockReset();
    vi.mocked(createResolvedAgentSession).mockResolvedValue({
      session: mockSessionHolder.session as any,
      sessionFile: undefined,
      runtimeId: "test-runtime",
      wasConfigured: true,
    });
    missionStore._setMission(createMockMission());
    mockSessionHolder.session.state.messages = [];
    mockSessionHolder.session.dispose = vi.fn();
  });

  afterEach(() => {
    loop?.stop();
    vi.restoreAllMocks();
  });

  /*
  FNXC:EngineTests 2026-07-18-04:40:
  Behavioral validation now requires a proven landed merge SHA
  (task.mergeDetails.commitSha) and a non-stale inspection root before FAIL can
  mint Fix Features. Stub the workspace-staleness probe so unit tests do not
  depend on a real git repo under rootDir=/tmp.
  */
  function proveLandedInspection() {
    vi.spyOn(MissionExecutionLoop.prototype as any, "isValidationWorkspaceStale").mockImplementation(
      async (landedSha: string | undefined) => {
        if (!landedSha) {
          return { workspaceStale: false, inspectionUnavailableReason: "landed merge SHA is unavailable" };
        }
        return { workspaceStale: false };
      },
    );
  }

  function landedTask(id: string, title: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      title,
      log: [],
      mergeDetails: { commitSha: "sha123" },
      ...extra,
    };
  }

  function expectValidatorCompletion(
    status: "passed" | "failed" | "blocked",
    effects: import("@fusion/core").ValidatorRunCompletionEffects,
  ) {
    expect(missionStore.completeValidatorRun).toHaveBeenCalledWith(
      "VR-1",
      status,
      expect.any(String),
      undefined,
      effects,
    );
  }

  function judgePass(assertionIds: string[]) {
    mockSessionHolder.session.state.messages = [
      {
        role: "assistant",
        content: JSON.stringify({
          status: "pass",
          assertions: assertionIds.map((id) => ({ assertionId: id, passed: true })),
          summary: "all good",
        }),
      },
    ];
  }

  it("AE2: behavioral assertion the judge calls pass → fails with no verification capability", async () => {
    proveLandedInspection();
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-B", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-B", "behavioral"));
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp" });
    loop.start();
    await loop.processTaskOutcome("FN-B");

    // No verification capability → behavioral default-to-fail → fix flow.
    expectValidatorCompletion("failed", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "failed" }],
      failures: [expect.objectContaining({
        featureId: "F-001",
        assertionId: "CA-1",
        message: expect.any(String),
      })],
    });
    expect(missionStore.createGeneratedFixFeature).toHaveBeenCalled();
    expect(missionStore.getFeature("F-001")?.status).not.toBe("done");
  });

  it("AE3: static assertion the judge calls pass → passes, no verification invoked", async () => {
    const verify = vi.fn();
    const capability: VerificationCapability = { verifyBehavioralAssertion: verify };
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-S", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "static" })]);
    taskStore._setTask({ id: "FN-S", title: "static", log: [] });
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: capability });
    loop.start();
    await loop.processTaskOutcome("FN-S");

    expect(verify).not.toHaveBeenCalled();
    expectValidatorCompletion("passed", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "passed" }],
    });
    expect(missionStore.getFeature("F-001")?.loopState).toBe("passed");
  });

  it("untyped assertions default to static — legacy judge pass path is preserved", async () => {
    const verify = vi.fn();
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-U", status: "in-progress" });
    missionStore._setFeature(feature);
    // No `type` field → normalizes to static.
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1" })]);
    taskStore._setTask({ id: "FN-U", title: "untyped", log: [] });
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-U");

    expect(verify).not.toHaveBeenCalled();
    expectValidatorCompletion("passed", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "passed" }],
    });
  });

  it("behavioral assertion confirmed by an injected verification capability → passes", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "pass", assertionId: req.assertionId, reason: "confirmed" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-BV", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-BV", "behavioral verified"));
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-BV");

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0]).toMatchObject({ assertionId: "CA-1", integrationSha: "sha123" });
    expectValidatorCompletion("passed", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "passed" }],
    });
    expect(missionStore.getFeature("F-001")?.loopState).toBe("passed");
  });

  it("behavioral assertion verification inconclusive → blocked, NO fix feature", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "inconclusive", assertionId: req.assertionId, reason: "no isolating sandbox backend" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-INC", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-INC", "inconclusive"));
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-INC");

    expectValidatorCompletion("blocked", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "blocked" }],
    });
    expect(missionStore.createGeneratedFixFeature).not.toHaveBeenCalled();
    expect(missionStore.getFeature("F-001")?.status).not.toBe("done");
  });

  it("mixed set: static passes via judge, behavioral confirmed via verification → overall pass", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "pass", assertionId: req.assertionId, reason: "confirmed" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-MIX", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [
      assertionRow({ id: "CA-static", type: "static" }),
      assertionRow({ id: "CA-behav", type: "behavioral" }),
    ]);
    taskStore._setTask(landedTask("FN-MIX", "mixed"));
    judgePass(["CA-static", "CA-behav"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-MIX");

    // Only the behavioral assertion is verified.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0]).toMatchObject({ assertionId: "CA-behav" });
    expectValidatorCompletion("passed", {
      featureId: "F-001",
      assertions: [
        { assertionId: "CA-static", status: "passed" },
        { assertionId: "CA-behav", status: "passed" },
      ],
    });
    expect(missionStore.getFeature("F-001")?.loopState).toBe("passed");
  });

  it("mixed set: behavioral observed wrong → overall fail even though static passes", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "fail", assertionId: req.assertionId, reason: "defect still reproduces" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-MIX2", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [
      assertionRow({ id: "CA-static", type: "static" }),
      assertionRow({ id: "CA-behav", type: "behavioral" }),
    ]);
    taskStore._setTask(landedTask("FN-MIX2", "mixed fail"));
    judgePass(["CA-static", "CA-behav"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-MIX2");

    expectValidatorCompletion("failed", {
      featureId: "F-001",
      assertions: [
        { assertionId: "CA-static", status: "passed" },
        { assertionId: "CA-behav", status: "failed" },
      ],
      failures: [expect.objectContaining({
        featureId: "F-001",
        assertionId: "CA-behav",
        message: "defect still reproduces",
      })],
    });
    expect(missionStore.createGeneratedFixFeature).toHaveBeenCalled();
    expect(missionStore.getFeature("F-001")?.status).not.toBe("done");
  });

  /*
  FNXC:ValidatorCompletionEffects 2026-09-29-11:18:
  A declined terminal CAS owns no follow-on work. These production-path cases keep validator
  assertions pending and prevent both pass notifications and failure remediation after ownership is lost.
  */
  it("a declined passing completion preserves pending assertions and emits no pass side effects", async () => {
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-DECLINED-PASS", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "static" })]);
    missionStore._setCompletionApplied(false);
    taskStore._setTask({ id: "FN-DECLINED-PASS", title: "declined pass", log: [] });
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp" });
    const emitSpy = vi.spyOn(loop, "emit");
    loop.start();
    await loop.processTaskOutcome("FN-DECLINED-PASS");

    expectValidatorCompletion("passed", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "passed" }],
    });
    expect(missionStore.getFeature("F-001")).toMatchObject({ loopState: "implementing" });
    expect(missionStore.listAssertionsForFeature("F-001")).toMatchObject([{ id: "CA-1", status: "pending" }]);
    expect(missionStore.logMissionEvent).not.toHaveBeenCalled();
    expect(missionStore.createGeneratedFixFeature).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("a declined failed completion creates no Fix Feature or failure event", async () => {
    proveLandedInspection();
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-DECLINED-FAIL", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    missionStore._setCompletionApplied(false);
    taskStore._setTask(landedTask("FN-DECLINED-FAIL", "declined fail"));
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp" });
    const emitSpy = vi.spyOn(loop, "emit");
    loop.start();
    await loop.processTaskOutcome("FN-DECLINED-FAIL");

    expectValidatorCompletion("failed", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "failed" }],
      failures: [expect.objectContaining({ featureId: "F-001", assertionId: "CA-1" })],
    });
    expect(missionStore.getFeature("F-001")).toMatchObject({ loopState: "implementing" });
    expect(missionStore.listAssertionsForFeature("F-001")).toMatchObject([{ id: "CA-1", status: "pending" }]);
    expect(missionStore.createGeneratedFixFeature).not.toHaveBeenCalled();
    expect(missionStore.logMissionEvent).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("U6/R6: failed verification passes the observed-vs-expected reason to the Fix Feature", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({
      verdict: "fail",
      assertionId: req.assertionId,
      reason: "defect still reproduces",
      detail: "button still does nothing on click",
    }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-R6", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-R6", "reason"));
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-R6");

    expect(missionStore.createGeneratedFixFeature).toHaveBeenCalled();
    const call = (missionStore.createGeneratedFixFeature as any).mock.calls[0];
    // (sourceFeatureId, runId, failedAssertionIds, failureReason)
    expect(call[0]).toBe("F-001");
    expect(call[2]).toEqual(["CA-1"]);
    expect(typeof call[3]).toBe("string");
    expect(call[3]).toContain("defect still reproduces");
    expect(call[5]).toMatchObject({
      assertions: [{
        assertionId: "CA-1",
        evidence: [{ kind: "behavioral-verification", text: expect.stringContaining("button still does nothing") }],
      }],
    });
  });

  it("U6/R16: a verification FAILURE emits a persisted mission event with outcome=fail", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "fail", assertionId: req.assertionId, reason: "defect still reproduces" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-EVT-F", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-EVT-F", "evt fail"));
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-EVT-F");

    const failEvent = (missionStore.logMissionEvent as any).mock.calls.find(
      (c: any[]) => c[3]?.code === "validation_failed",
    );
    expect(failEvent).toBeDefined();
    expect(failEvent[1]).toBe("error");
    expect(failEvent[3]).toMatchObject({ outcome: "fail" });
  });

  it("U6/R16+R21: an INCONCLUSIVE verdict emits a distinguishable infra-failure event and no Fix Feature", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "inconclusive", assertionId: req.assertionId, reason: "no isolating sandbox backend" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-EVT-INC", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-EVT-INC", "evt inconclusive"));
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-EVT-INC");

    // No remediation work.
    expect(missionStore.createGeneratedFixFeature).not.toHaveBeenCalled();
    // Completed as blocked (no new run status), distinct from a real fail.
    expectValidatorCompletion("blocked", {
      featureId: "F-001",
      assertions: [{ assertionId: "CA-1", status: "blocked" }],
    });

    const incEvent = (missionStore.logMissionEvent as any).mock.calls.find(
      (c: any[]) => c[3]?.code === "verification_inconclusive",
    );
    expect(incEvent).toBeDefined();
    // Distinguishable from a real fail: warning severity + infra-failure marker.
    expect(incEvent[1]).toBe("warning");
    expect(incEvent[3]).toMatchObject({ outcome: "inconclusive", infraFailure: true });
    // A real-fail event must NOT have been emitted for this run.
    const failEvent = (missionStore.logMissionEvent as any).mock.calls.find(
      (c: any[]) => c[3]?.code === "validation_failed",
    );
    expect(failEvent).toBeUndefined();
  });

  it("U6/R16: a swallowed Fix-Feature triage error is durably recorded, not silent", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "fail", assertionId: req.assertionId, reason: "defect still reproduces" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-TRIAGE", status: "in-progress" });
    missionStore._setFeature(feature);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-TRIAGE", "triage fail"));
    judgePass(["CA-1"]);
    // Make triage throw so the swallow path is exercised.
    missionStore.triageFeature = vi.fn(async () => { throw new Error("triage boom"); }) as any;

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-TRIAGE");

    const triageEvent = (missionStore.logMissionEvent as any).mock.calls.find(
      (c: any[]) => c[3]?.code === "fix_feature_triage_needs_attention",
    );
    expect(triageEvent).toBeDefined();
    expect(triageEvent[1]).toBe("warning");
    expect(triageEvent[2]).not.toContain("triage boom");
    expect(triageEvent[3]).toMatchObject({ state: "needs-triage" });
  });

  it("silently reuses an already-triaged fix with its canonical linked task", async () => {
    proveLandedInspection();
    const verify = vi.fn(async (req): Promise<VerificationOutcome> => ({ verdict: "fail", assertionId: req.assertionId, reason: "defect still reproduces" }));
    const feature = createMockFeature({ loopState: "implementing", taskId: "FN-DUPLICATE", status: "in-progress" });
    const existingFix = createMockFeature({
      id: "FIX-F-001", taskId: "TASK-FIX-F-001", status: "in-progress", loopState: "implementing",
      generatedFromFeatureId: "F-001", generatedFromRunId: "VR-existing",
    });
    missionStore._setFeature(feature);
    missionStore._setFeature(existingFix);
    missionStore._setAssertions("F-001", [assertionRow({ id: "CA-1", type: "behavioral" })]);
    taskStore._setTask(landedTask("FN-DUPLICATE", "duplicate trigger"));
    taskStore._setTask({ id: "TASK-FIX-F-001", title: "existing remediation" });
    missionStore.createGeneratedFixFeature = vi.fn(() => existingFix) as any;
    judgePass(["CA-1"]);

    loop = new MissionExecutionLoop({ taskStore: taskStore as any, missionStore: missionStore as any, rootDir: "/tmp", verificationCapability: { verifyBehavioralAssertion: verify } });
    loop.start();
    await loop.processTaskOutcome("FN-DUPLICATE");

    expect(missionStore.triageFeature).not.toHaveBeenCalled();
    expect((missionStore.logMissionEvent as any).mock.calls.some((call: any[]) => call[3]?.code === "fix_feature_triage_needs_attention")).toBe(false);
  });
});
