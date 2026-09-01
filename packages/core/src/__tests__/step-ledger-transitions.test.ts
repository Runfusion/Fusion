import { describe, expect, it } from "vitest";
import { MAX_LOG_SCAN } from "../merge/completed-promotion-failure-provenance.js";
import { startStepImpl, updateStepImpl } from "../task-store/merge-queue-ops.js";
import { evaluateStepLedgerSeal } from "../task-store/step-ledger-seal.js";
import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";

const COMPLETION_MARKER = "Task marked done by agent";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-255",
    title: "Step ledger",
    description: "Protect the durable step timeline.",
    priority: "normal",
    column: "in-progress",
    currentStep: 0,
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implementation", status: "in-progress" },
    ],
    log: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function stepStore(initial: Task) {
  let task = structuredClone(initial);
  const store = {
    isWatching: false,
    taskCache: new Map(),
    taskDir: () => "/virtual/FN-255",
    readTaskJson: async () => structuredClone(task),
    parseStepsFromPrompt: async () => task.steps,
    atomicWriteTaskJson: async (_dir: string, next: Task) => { task = structuredClone(next); },
    withTaskLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    emit: () => true,
    getSettingsFast: async () => ({ proactiveTaskChatEnabled: false }),
    appendAgentLog: async () => undefined,
  } as unknown as TaskStore;
  return { store, read: () => structuredClone(task) };
}

function actions(task: Task): string[] {
  return task.log.map((entry) => entry.action);
}

function stepLines(task: Task): string[] {
  return actions(task).filter((action) => /^Step \d+ \(.+\) → /.test(action));
}

function withCompletion(task: Task): Task {
  task.log.push({ timestamp: "2026-08-29T00:01:00.000Z", action: COMPLETION_MARKER });
  return task;
}

describe("step ledger transitions", () => {
  it("records only a real in-progress transition while preserving the resumed start disposition", async () => {
    const task = makeTask({ steps: [{ name: "Preflight", status: "pending" }] });
    const fixture = stepStore(task);

    const first = await startStepImpl(fixture.store, task.id, 0);
    const second = await startStepImpl(fixture.store, task.id, 0);

    expect(first).toMatchObject({ accepted: true, disposition: "started" });
    expect(second).toMatchObject({ accepted: true, disposition: "resumed" });
    expect(stepLines(fixture.read())).toEqual(["Step 0 (Preflight) → in-progress"]);
    expect(actions(fixture.read())).not.toContainEqual(expect.stringContaining("Step ledger reopened"));
  });

  it("does not repeat a done ledger line while retaining reports and stuck-kill cleanup", async () => {
    const task = makeTask({
      steps: [{ name: "Preflight", status: "done" }],
      stuckKillCount: 2,
    });
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 0, "done", { summary: "Still completed." });

    expect(fixture.read().stuckKillCount).toBeUndefined();
    expect(fixture.read().stepReports).toMatchObject([{ stepIndex: 0, summary: "Still completed." }]);
    expect(actions(fixture.read())).not.toContainEqual(expect.stringContaining("Reset stuck-kill streak"));
    expect(stepLines(fixture.read())).toEqual([]);
  });

  it("still records real transitions", async () => {
    const task = makeTask({ steps: [{ name: "Preflight", status: "pending" }] });
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 0, "done");

    expect(stepLines(fixture.read())).toEqual(["Step 0 (Preflight) → done"]);
  });

  it("refuses a genuine post-completion transition without changing the step", async () => {
    const task = withCompletion(makeTask());
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 1, "done");

    expect(fixture.read().steps[1]?.status).toBe("in-progress");
    expect(actions(fixture.read())).toContainEqual(expect.stringContaining("Ignored post-completion done for step 1 (Implementation)"));
    expect(stepLines(fixture.read())).toEqual([]);
  });

  it("admits and reopens a graph-source pending-step start after completion", async () => {
    const task = withCompletion(makeTask({ steps: [{ name: "Preflight", status: "done" }, { name: "Implementation", status: "pending" }] }));
    const fixture = stepStore(task);

    const result = await startStepImpl(fixture.store, task.id, 1, { source: "graph" });

    expect(result).toMatchObject({ accepted: true, disposition: "started" });
    expect(fixture.read().steps[1]?.status).toBe("in-progress");
    expect(actions(fixture.read())).toContain("Step ledger reopened — step 1 (Implementation) started after completion");
    expect(actions(fixture.read())).not.toContainEqual(expect.stringContaining("Ignored post-completion in-progress for step 1"));
    expect(actions(fixture.read())).not.toContainEqual(expect.stringContaining("[integrity-warning] graph-source updateStep suppressed"));
  });

  it("still warns when a graph-source completion projection arrives after completion", async () => {
    const task = withCompletion(makeTask());
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 1, "done", { source: "graph" });

    expect(fixture.read().steps[1]?.status).toBe("in-progress");
    expect(actions(fixture.read())).toContainEqual(expect.stringContaining("Ignored post-completion done for step 1 (Implementation)"));
    expect(actions(fixture.read())).toContainEqual(expect.stringContaining("[integrity-warning] graph-source updateStep suppressed"));
  });

  it("lets an admitted post-completion start finish in the reopened ledger", async () => {
    const task = withCompletion(makeTask({ steps: [{ name: "Implementation", status: "pending" }] }));
    const fixture = stepStore(task);

    await startStepImpl(fixture.store, task.id, 0, { source: "graph" });
    await updateStepImpl(fixture.store, task.id, 0, "done", { source: "graph" });

    expect(fixture.read().steps[0]?.status).toBe("done");
    expect(stepLines(fixture.read())).toEqual([
      "Step 0 (Implementation) → in-progress",
      "Step 0 (Implementation) → done",
    ]);
  });

  it("still refuses a pending-to-done projection after completion", async () => {
    const task = withCompletion(makeTask({ steps: [{ name: "Implementation", status: "pending" }] }));
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 0, "done", { source: "graph" });

    expect(fixture.read().steps[0]?.status).toBe("pending");
    expect(actions(fixture.read())).toContainEqual(expect.stringContaining("Ignored post-completion done for step 0 (Implementation)"));
    expect(actions(fixture.read())).toContainEqual(expect.stringContaining("[integrity-warning] graph-source updateStep suppressed"));
  });

  it("still refuses a completed-step restart before consulting the completion seal", async () => {
    const task = withCompletion(makeTask({ steps: [{ name: "Implementation", status: "done" }] }));
    const fixture = stepStore(task);

    const result = await startStepImpl(fixture.store, task.id, 0, { source: "graph" });

    expect(result).toMatchObject({ accepted: false, disposition: "terminal" });
    expect(fixture.read().steps[0]?.status).toBe("done");
    expect(actions(fixture.read())).toContainEqual(expect.stringContaining("Ignored done→in-progress regression"));
    expect(actions(fixture.read())).not.toContainEqual(expect.stringContaining("Ignored post-completion"));
  });

  it("leaves a same-status write inside the completion window completely silent", async () => {
    const task = withCompletion(makeTask({ steps: [{ name: "Preflight", status: "done" }] }));
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 0, "done");

    expect(actions(fixture.read())).toEqual([COMPLETION_MARKER]);
  });

  it("reopens before a pending reset and permits subsequent implementation transitions", async () => {
    const task = withCompletion(makeTask({ steps: [{ name: "Preflight", status: "done" }] }));
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 0, "pending");
    await updateStepImpl(fixture.store, task.id, 0, "in-progress");

    expect(actions(fixture.read())).toEqual([
      COMPLETION_MARKER,
      "Step ledger reopened — step 0 (Preflight) returned to pending after completion",
      "Step 0 (Preflight) → pending",
      "Step 0 (Preflight) → in-progress",
    ]);
  });

  it("reopens before an operator edit instead of refusing it", async () => {
    const task = withCompletion(makeTask());
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 1, "done", { operatorOverride: true });

    expect(fixture.read().steps[1]?.status).toBe("done");
    expect(actions(fixture.read())).toContain("Step ledger reopened — step 1 (Implementation) edited by operator after completion");
    expect(stepLines(fixture.read())).toContain("Step 1 (Implementation) → done");
  });

  it.each([
    "Executor using model: openai/gpt-5.6",
    "Resumed agent session after unpause (model: openai/gpt-5.6)",
  ])("lets a fresh implementation marker supersede completion: %s", async (reentryMarker) => {
    const task = withCompletion(makeTask());
    task.log.push({ timestamp: "2026-08-29T00:02:00.000Z", action: reentryMarker });
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 1, "done");

    expect(fixture.read().steps[1]?.status).toBe("done");
    expect(stepLines(fixture.read())).toContain("Step 1 (Implementation) → done");
  });

  it.each([
    "Lifecycle move: in-progress → in-review (forward)",
    "[pre-merge] Starting workflow step: Code Review",
  ])("does not treat %s as an implementation re-entry", async (nonReentryMarker) => {
    const task = withCompletion(makeTask());
    task.log.push({ timestamp: "2026-08-29T00:02:00.000Z", action: nonReentryMarker });
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 1, "done");

    expect(fixture.read().steps[1]?.status).toBe("in-progress");
    expect(actions(fixture.read())).toContainEqual(expect.stringContaining("Ignored post-completion done"));
  });

  it("fails open when a completion marker has aged out of the bounded tail", async () => {
    const task = withCompletion(makeTask());
    task.log.push(...Array.from({ length: MAX_LOG_SCAN }, (_, index) => ({
      timestamp: "2026-08-29T00:02:00.000Z",
      action: `unrelated activity ${index}`,
    })));
    const fixture = stepStore(task);

    await updateStepImpl(fixture.store, task.id, 1, "done");

    expect(evaluateStepLedgerSeal(fixture.read().log)).toEqual({ sealed: false });
    expect(fixture.read().steps[1]?.status).toBe("done");
  });

  it("preserves regression and dependency-order suppressions", async () => {
    const regression = stepStore(makeTask({ steps: [{ name: "Preflight", status: "done" }] }));
    const regressionResult = await startStepImpl(regression.store, "FN-255", 0);
    expect(regressionResult).toMatchObject({ accepted: false, disposition: "terminal" });
    expect(actions(regression.read())).toContainEqual(expect.stringContaining("Ignored done→in-progress regression"));

    const dependency = stepStore(makeTask({
      steps: [{ name: "Preflight", status: "pending" }, { name: "Implementation", status: "pending" }],
    }));
    await updateStepImpl(dependency.store, "FN-255", 1, "done", { source: "graph" });
    expect(dependency.read().steps[1]?.status).toBe("pending");
    expect(actions(dependency.read())).toContainEqual(expect.stringContaining("Ignored dependency-order done"));
  });
});
