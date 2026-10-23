import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

/*
FNXC:WorkflowStepTimeout 2026-10-20-07:04:
`workflowStepTimeoutMs` moved out of project settings into the per-workflow settings catalog
(`BUILTIN_MOVED_WORKFLOW_SETTINGS`, default 900000). A raw `store.getSettings()` map therefore no
longer carries the key, so a reader using `settings.workflowStepTimeoutMs ?? 900_000` silently
resolves the declaration default and an operator's stored 1800000 (30 minutes) stays inert on the
production `execute-workflow-graph` -> `run-graph-custom-node` -> `executeWorkflowStep` path.
These tests drive the real `TaskExecutor.executeWorkflowStep` boundary with an inert session and
fake timers, so the assertion is on the ACTUAL armed `setTimeout`: still pending past the old
900001 ms, and genuinely timed out / disposed at the stored 1800000 ms.
*/

const { mkdtempSync, rmSync } = await vi.importActual<typeof import("node:fs")>("node:fs");

let fixtureRoot: string;
let fixtureWorktree: string;

const PROJECT_ID = "timeout-project";
const FOREIGN_PROJECT_ID = "other-timeout-project";
const TASK_ID = "TASK-TIMEOUT-1";
const WORKFLOW_ID = "builtin:coding";

const STORED_THIRTY_MINUTES = 1_800_000;
const LEGACY_RAW_VALUE = 1_234_000;
const FOREIGN_PROJECT_VALUE = 300_000;

/** FNXC:WorkflowStepTimeout 2026-10-20-08:00: Build a parent task whose selected workflow owns the timeout setting. */
function taskFixture(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: TASK_ID,
    title: "Honor the selected workflow step timeout",
    description: "The dispatched step must arm the operator's stored timeout.",
    column: "in-progress" as const,
    worktree: fixtureWorktree,
    branch: "fusion/workflow-timeout",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The three step shapes that must all honor the stored value: Plan Review, Code Review, and an
 *  ordinary non-review prompt step. */
function stepFixture(kind: "plan-review" | "code-review" | "prompt") {
  const now = new Date().toISOString();
  const shared = {
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "gate" as const,
    prompt: "Review or execute the scoped work.",
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  if (kind === "plan-review") {
    return {
      ...shared,
      id: "graph:plan-review-step",
      name: "Plan Review",
      optionalGroupId: "plan-review",
      reviewKind: "plan" as const,
    };
  }
  if (kind === "code-review") {
    return {
      ...shared,
      id: "graph:code-review-step",
      name: "Code Review",
      optionalGroupId: "code-review",
      reviewKind: "code" as const,
    };
  }
  return {
    ...shared,
    id: "step:documentation-delivery",
    name: "Documentation Delivery",
    gateMode: "advisory" as const,
  };
}

type ResolverMode = "ok" | "absent" | "throwing";

interface HarnessOptions {
  /** The RAW project settings map, exactly as `execute-workflow-graph.ts` loads it. */
  rawSettings?: Record<string, unknown>;
  /** Stored per-(workflow, project) workflow-setting values. */
  storedValues?: Record<string, unknown>;
  resolver?: ResolverMode;
  step?: ReturnType<typeof stepFixture>;
  task?: Record<string, unknown>;
  stepOptions?: Record<string, unknown>;
  /** When set the fake session's prompt resolves after emitting this verdict instead of hanging. */
  completedOutput?: string;
}

/**
 * Builds the store with ONLY the effective-settings resolver surface the production helper reads,
 * keyed by `(workflowId, projectId)` and by task id exactly like the real PostgreSQL store. The
 * foreign-project row exists so a wrong project key cannot pass: it resolves the wrong timeout.
 */
function harness(storeOptions: HarnessOptions) {
  const rawSettings = storeOptions.rawSettings ?? {};
  const resolver = storeOptions.resolver ?? "ok";
  const store = createMockStore();
  store.getSettings.mockResolvedValue(rawSettings);
  const selectionReads: string[] = [];
  const valuesReads: Array<{ workflowId: string; projectId: string }> = [];

  const readSelection = (taskId: string) => {
    selectionReads.push(taskId);
    return taskId === TASK_ID ? { workflowId: WORKFLOW_ID, stepIds: [] } : undefined;
  };
  const readValues = (workflowId: string, projectId: string) => {
    valuesReads.push({ workflowId, projectId });
    // A wrong project key resolves THIS value, not the one under test.
    if (projectId !== PROJECT_ID) return { workflowStepTimeoutMs: FOREIGN_PROJECT_VALUE };
    return storeOptions.storedValues ?? {};
  };

  if (resolver === "ok") {
    store.getTaskWorkflowSelection = vi.fn(readSelection);
    store.getTaskWorkflowSelectionAsync = vi.fn(async (taskId: string) => readSelection(taskId));
    store.getWorkflowDefinition = vi.fn(async (_id: string) => undefined);
    (store as Record<string, unknown>).getWorkflowSettingValues = vi.fn(readValues);
    (store as Record<string, unknown>).getWorkflowSettingsProjectId = vi.fn(() => PROJECT_ID);
  } else if (resolver === "throwing") {
    store.getTaskWorkflowSelection = vi.fn(() => {
      throw new Error("selection read failed");
    });
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => {
      throw new Error("selection read failed");
    });
    store.getWorkflowDefinition = vi.fn(async () => {
      throw new Error("definition read failed");
    });
    (store as Record<string, unknown>).getWorkflowSettingValues = vi.fn(() => {
      throw new Error("values read failed");
    });
    (store as Record<string, unknown>).getWorkflowSettingsProjectId = vi.fn(() => {
      throw new Error("project id read failed");
    });
  } else {
    // The resolver surface is entirely absent, as on a minimal/legacy store adapter.
    delete (store as Record<string, unknown>).getTaskWorkflowSelection;
    delete (store as Record<string, unknown>).getTaskWorkflowSelectionAsync;
    delete (store as Record<string, unknown>).getWorkflowDefinition;
    delete (store as Record<string, unknown>).getWorkflowSettingValues;
    delete (store as Record<string, unknown>).getWorkflowSettingsProjectId;
  }

  // A session whose prompt never settles is the only way to observe the armed timeout itself.
  let promptStartedResolve: () => void = () => {};
  const promptStarted = new Promise<void>((resolve) => {
    promptStartedResolve = resolve;
  });
  const listeners: Array<(event: unknown) => void> = [];
  const session: Record<string, unknown> = {
    state: {},
    subscribe: (listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    },
    prompt: vi.fn(async () => {
      promptStartedResolve();
      if (storeOptions.completedOutput === undefined) return new Promise<void>(() => {});
      for (const listener of listeners) {
        listener({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: storeOptions.completedOutput,
          },
        });
      }
    }),
    dispose: vi.fn(),
  };
  mockedCreateFnAgent.mockImplementation(async () => ({ session }) as never);

  const executor = new TaskExecutor(store as never, fixtureRoot, {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as never);

  const run = (executor as unknown as {
    executeWorkflowStep: (
      task: unknown,
      workflowStep: unknown,
      worktreePath: string,
      settings: unknown,
      taskEnv: unknown,
      stepOptions?: unknown,
    ) => Promise<Record<string, unknown>>;
  }).executeWorkflowStep(
    storeOptions.task ? taskFixture(storeOptions.task) : taskFixture(),
    storeOptions.step ?? stepFixture("prompt"),
    fixtureWorktree,
    rawSettings,
    undefined,
    storeOptions.stepOptions,
  );
  // The real executor attaches a rejection handler for the harness's own diagnostics only; the
  // returned promise stays the single observable under test.
  run.catch(() => undefined);

  return { run, session, promptStarted, selectionReads, valuesReads, store };
}

/** Settles the awaits that follow a fired timer without advancing the clock any further. */
async function drain(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

const APPROVE_OUTPUT = '{"verdict":"APPROVE","notes":"Reviewed the scoped work and found it correct."}';

/** FNXC:WorkflowStepTimeout 2026-10-20-08:00: Advance only the fake clock and verify that the session remains live before its configured deadline. */
async function expectStillRunning(h: ReturnType<typeof harness>, upToMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(upToMs);
  await drain();
  expect(h.session.dispose, `session must not be disposed at ${upToMs}ms`).not.toHaveBeenCalled();
}

describe("workflow-step effective timeout (moved workflowStepTimeoutMs)", () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "fusion-workflow-timeout-"));
    fixtureWorktree = join(fixtureRoot, "worktree");
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps the 900001st millisecond harmless and disposes at the stored 1800000ms", async () => {
    const h = harness({
      // The moved key is ABSENT from raw project settings — the operator's live shape.
      rawSettings: { maxParallelSteps: 2 },
      storedValues: { workflowStepTimeoutMs: STORED_THIRTY_MINUTES },
    });
    await h.promptStarted;

    // Red-before proof: the old raw reader arms 900000ms, so it is already disposed by now.
    await expectStillRunning(h, 900_001);

    await vi.advanceTimersByTimeAsync(STORED_THIRTY_MINUTES - 900_001);
    await drain();
    expect(sessionDisposed(h)).toBe(true);
    const outcome = await h.run;
    expect(outcome).toMatchObject({
      success: false,
      timedOut: true,
      error: `workflow step timed out after ${STORED_THIRTY_MINUTES}ms`,
    });
  });

  describe.each([
    ["plan-review", "Plan Review"],
    ["code-review", "Code Review"],
    ["prompt", "an ordinary prompt step"],
  ] as const)("%s step honors the stored 1800000ms", (kind, label) => {
    it(`runs past 900001ms and times out at 1800000ms for ${label}`, async () => {
      const h = harness({
        rawSettings: {},
        storedValues: { workflowStepTimeoutMs: STORED_THIRTY_MINUTES },
        step: stepFixture(kind),
      });
      await h.promptStarted;
      if (kind !== "prompt") {
        expect(h.selectionReads).toEqual([TASK_ID]);
        expect(h.valuesReads).toEqual([{ workflowId: WORKFLOW_ID, projectId: PROJECT_ID }]);
      }
      await vi.advanceTimersByTimeAsync(900_001);
      await drain();
      expect(sessionDisposed(h)).toBe(false);

      await vi.advanceTimersByTimeAsync(STORED_THIRTY_MINUTES - 900_001);
      await drain();
      const outcome = await h.run;
      expect(outcome).toMatchObject({
        success: false,
        timedOut: true,
        error: `workflow step timed out after ${STORED_THIRTY_MINUTES}ms`,
      });
      // An honest abort never manufactures a reviewer verdict.
      expect(outcome.verdict).toBeUndefined();
      expect(outcome.notes).toBeUndefined();
    });
  });

  it("lets a stored workflow value override a legacy raw project value", async () => {
    const h = harness({
      rawSettings: { workflowStepTimeoutMs: LEGACY_RAW_VALUE },
      storedValues: { workflowStepTimeoutMs: STORED_THIRTY_MINUTES },
    });
    await h.promptStarted;
    await vi.advanceTimersByTimeAsync(LEGACY_RAW_VALUE - 1);
    await drain();
    expect(sessionDisposed(h)).toBe(false);

    await vi.advanceTimersByTimeAsync(STORED_THIRTY_MINUTES - (LEGACY_RAW_VALUE - 1));
    await drain();
    const outcome = await h.run;
    expect(outcome).toMatchObject({
      success: false,
      timedOut: true,
      error: `workflow step timed out after ${STORED_THIRTY_MINUTES}ms`,
    });
  });

  it("uses the 900000ms declaration default when nothing is stored and raw omits the key", async () => {
    const h = harness({ rawSettings: {}, storedValues: {} });
    await h.promptStarted;
    await vi.advanceTimersByTimeAsync(899_999);
    await drain();
    expect(sessionDisposed(h)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await drain();
    const outcome = await h.run;
    expect(outcome).toMatchObject({
      success: false,
      timedOut: true,
      error: "workflow step timed out after 900000ms",
    });
  });

  it("preserves a legacy raw value when no stored workflow override exists", async () => {
    // Pre-migration parity: a declaration default must never clobber a real project value.
    const h = harness({
      rawSettings: { workflowStepTimeoutMs: LEGACY_RAW_VALUE },
      storedValues: {},
    });
    await h.promptStarted;
    await vi.advanceTimersByTimeAsync(LEGACY_RAW_VALUE - 1);
    await drain();
    expect(sessionDisposed(h)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await drain();
    const outcome = await h.run;
    expect(outcome).toMatchObject({
      success: false,
      timedOut: true,
      error: `workflow step timed out after ${LEGACY_RAW_VALUE}ms`,
    });
  });

  it.each([
    ["absent", "resolver methods are absent"],
    ["throwing", "resolver reads throw"],
  ] as const)("falls back to the raw base when %s", async (resolver, label) => {
    void label;
    const h = harness({
      rawSettings: { workflowStepTimeoutMs: LEGACY_RAW_VALUE },
      storedValues: { workflowStepTimeoutMs: STORED_THIRTY_MINUTES },
      resolver,
    });
    await h.promptStarted;
    await vi.advanceTimersByTimeAsync(LEGACY_RAW_VALUE - 1);
    await drain();
    expect(sessionDisposed(h)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await drain();
    const outcome = await h.run;
    expect(outcome).toMatchObject({
      success: false,
      timedOut: true,
      error: `workflow step timed out after ${LEGACY_RAW_VALUE}ms`,
    });
  });

  it("clamps a stored value below the 60000ms floor", async () => {
    const h = harness({ rawSettings: {}, storedValues: { workflowStepTimeoutMs: 1_000 } });
    await h.promptStarted;
    await vi.advanceTimersByTimeAsync(59_999);
    await drain();
    expect(sessionDisposed(h)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await drain();
    const outcome = await h.run;
    expect(outcome).toMatchObject({
      success: false,
      timedOut: true,
      error: "workflow step timed out after 60000ms",
    });
  });

  it("clears the timeout once the step completes before expiry", async () => {
    const h = harness({
      rawSettings: {},
      storedValues: { workflowStepTimeoutMs: STORED_THIRTY_MINUTES },
      completedOutput: APPROVE_OUTPUT,
    });
    const outcome = await h.run;
    expect(outcome).toMatchObject({ success: true });
    // A completed step must leave no armed timeout behind that could dispose the session later.
    expect(vi.getTimerCount()).toBe(0);
    expect(sessionDisposed(h)).toBe(true);

    await vi.advanceTimersByTimeAsync(STORED_THIRTY_MINUTES * 2);
    await drain();
    expect(disposeCallCount(h)).toBe(1);
  });

  it("resolves the ORIGINAL parent task's selection and its own project only", async () => {
    const h = harness({
      rawSettings: {},
      // The same workflow id under a foreign project carries a different value; reading it would
      // mean the merge ignored the store's project identity.
      storedValues: { workflowStepTimeoutMs: STORED_THIRTY_MINUTES },
    });
    await h.promptStarted;
    await vi.advanceTimersByTimeAsync(900_001);
    await drain();
    expect(sessionDisposed(h)).toBe(false);

    // Discriminating: a selection read for ANY other identity (a synthetic reviewer task, a
    // workspace sub-task, a fallback attempt) resolves no selection and therefore the 900000ms
    // default, which fails the assertion above.
    expect(h.selectionReads.length).toBeGreaterThan(0);
    expect(new Set(h.selectionReads)).toEqual(new Set([TASK_ID]));
    // Project isolation: only this store's project key may be consulted.
    expect(h.valuesReads.length).toBeGreaterThan(0);
    expect(new Set(h.valuesReads.map((read) => read.projectId))).toEqual(new Set([PROJECT_ID]));
    await vi.advanceTimersByTimeAsync(STORED_THIRTY_MINUTES - 900_001);
    await expect(h.run).resolves.toMatchObject({ success: false, timedOut: true });
  });
});

/** FNXC:WorkflowStepTimeout 2026-10-20-08:00: Observe session disposal through the real executor fixture. */
function sessionDisposed(h: { session: Record<string, unknown> }): boolean {
  return disposeCallCount(h) > 0;
}

/** FNXC:WorkflowStepTimeout 2026-10-20-08:00: Count teardown calls so completion cannot leave a second timer-driven disposal. */
function disposeCallCount(h: { session: Record<string, unknown> }): number {
  return (h.session.dispose as ReturnType<typeof vi.fn>).mock.calls.length;
}
