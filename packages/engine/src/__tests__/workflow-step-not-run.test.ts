import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskDetail, TaskStore, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { isPlanReviewSatisfied } from "@fusion/core";
import { runExecutorDeterministicVerification } from "../executor/deterministic-verification.js";
import { buildWorkflowGateActivityMetadata } from "../executor/execute-workflow-graph.js";
import { runDeterministicVerification } from "../merger.js";
import { runDeterministicVerificationGate } from "../workflow-node-runners/verification-gate.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

const settings = { experimentalFeatures: { workflowGraphExecutor: true } } as Settings;

function task(enabledWorkflowSteps: string[] | undefined): TaskDetail {
  return { id: "FN-226", enabledWorkflowSteps } as TaskDetail;
}

function groupIr(id = "verification"): WorkflowIr {
  return {
    version: "v2",
    name: "not-run-optional-group",
    columns: [{ id: "in-review", name: "Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id,
        kind: "optional-group",
        config: {
          name: id === "plan-review" ? "Plan Review" : "Verification",
          defaultOn: false,
          ...(id === "plan-review" ? { reviewKind: "plan" as const } : {}),
          template: {
            nodes: [{ id: "check", kind: "gate", config: { workflowAction: "deterministic-verification" } }],
            edges: [],
          },
        },
      },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: id },
      { from: id, to: "end", condition: "success" },
      { from: id, to: "end", condition: "failure" },
    ],
  };
}

function directIr(id = "custom-check"): WorkflowIr {
  return {
    version: "v2",
    name: "not-run-direct-node",
    columns: [{ id: "in-review", name: "Review", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id, kind: "gate", config: { name: "Custom check", reviewKind: "code" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: id },
      { from: id, to: "end", condition: "success" },
    ],
  };
}

describe("workflow-step not-run recording", () => {
  it("records an unconfigured deterministic optional-group check as not executed, never passed", async () => {
    const records: WorkflowStepResult[] = [];
    const logs: Array<{ summary: string; detail?: string }> = [];
    const executor = new WorkflowGraphExecutor({
      handlers: {
        gate: async (node) => runDeterministicVerificationGate(
          { store: {} as TaskStore },
          node,
          { id: "FN-226" } as Task,
          {} as Settings,
          "/worktree",
        ),
      },
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result); },
      logTaskEntry: (summary, detail) => { logs.push({ summary, detail }); },
    });

    await executor.run(task(["verification"]), settings, groupIr());

    const terminal = records.findLast((entry) => entry.workflowStepId === "verification");
    expect(terminal).toMatchObject({ status: "skipped", notRunReason: "not-configured" });
    expect(terminal?.status).not.toBe("passed");
    expect(logs.some((entry) => entry.summary.includes("Workflow step not executed"))).toBe(true);
    expect(logs.some((entry) => entry.summary.includes("Workflow step completed"))).toBe(false);
  });

  it("records a successful top-level no-run signal as skipped through node progress", async () => {
    const records: WorkflowStepResult[] = [];
    const logs: Array<{ summary: string; detail?: string }> = [];
    const executor = new WorkflowGraphExecutor({
      handlers: {
        gate: async () => ({
          outcome: "success",
          value: "workflow-step-skipped",
          contextPatch: {
            notRunReason: "execution-mode-skip",
            output: "Fast mode skipped this check — NOTHING WAS VERIFIED.",
          },
        }),
      },
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result); },
      logTaskEntry: (summary, detail) => { logs.push({ summary, detail }); },
    });

    await executor.run(task([]), settings, directIr());

    const terminal = records.findLast((entry) => entry.workflowStepId === "custom-check");
    expect(terminal).toMatchObject({ source: "node", status: "skipped", notRunReason: "execution-mode-skip" });
    expect(logs.some((entry) => entry.summary.includes("Workflow step not executed"))).toBe(true);
    expect(logs.some((entry) => entry.summary.includes("Workflow step completed"))).toBe(false);
  });

  it("excludes Plan Review from not-run mapping in both recorders", async () => {
    for (const ir of [groupIr("plan-review"), directIr("plan-review")]) {
      const records: WorkflowStepResult[] = [];
      const executor = new WorkflowGraphExecutor({
        handlers: {
          gate: async () => ({
            outcome: "success",
            contextPatch: { notRunReason: "execution-mode-skip", output: "No run" },
          }),
        },
        recordWorkflowStepResult: async (_taskId, result) => { records.push(result); },
      });

      await executor.run(task(["plan-review"]), settings, ir);
      const terminal = records.findLast((entry) => entry.workflowStepId === "plan-review");
      expect(terminal).toMatchObject({ status: "passed" });
      expect(terminal).not.toHaveProperty("notRunReason");
      expect(isPlanReviewSatisfied(terminal!)).toBe(true);
    }
  });

  it("marks only not-run passed-channel activity with honest metadata", () => {
    const notRun = {
      workflowStepId: "verification",
      workflowStepName: "Verification",
      status: "skipped",
      notRunReason: "not-configured",
    } as WorkflowStepResult;
    const passed = {
      workflowStepId: "verification",
      workflowStepName: "Verification",
      status: "passed",
    } as WorkflowStepResult;

    expect(buildWorkflowGateActivityMetadata(notRun, notRun)).toEqual({
      stepId: "verification",
      status: "skipped",
      attempt: 0,
      notRun: true,
    });
    expect(buildWorkflowGateActivityMetadata(passed, passed)).toEqual({
      stepId: "verification",
      status: "passed",
      attempt: 0,
    });
  });

  it("marks executor deterministic verification as not run when no command exists", async () => {
    const store = { logEntry: vi.fn() } as unknown as TaskStore;
    const verification = await runExecutorDeterministicVerification(
      { store, getRunContextFor: () => undefined },
      { id: "FN-226" } as Task,
      "/worktree",
      {} as Settings,
    );

    expect(verification).toEqual({ allPassed: true, notRun: true });
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-226",
      expect.stringContaining("passed"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("logs merge verification as not executed instead of passed when no command exists", async () => {
    const store = {
      getSettings: vi.fn(async () => ({})),
      logEntry: vi.fn(async () => undefined),
      appendAgentLog: vi.fn(async () => undefined),
    } as unknown as TaskStore;

    const verification = await runDeterministicVerification(store, "/worktree", "FN-226");

    expect(verification).toEqual({ allPassed: true, notRun: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-226",
      expect.stringContaining("not executed"),
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-226",
      "Deterministic merge verification passed",
    );
  });

  it("keeps disabled groups byte-inert and infrastructure faults blocking", async () => {
    const records: WorkflowStepResult[] = [];
    const handler = vi.fn(async () => ({
      outcome: "failure" as const,
      value: "verification-infrastructure-failure",
      contextPatch: { output: "testCommand: timed-out" },
    }));
    const executor = new WorkflowGraphExecutor({
      handlers: { gate: handler },
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result); },
    });

    await executor.run(task([]), settings, groupIr());
    expect(handler).not.toHaveBeenCalled();
    expect(records).toEqual([]);

    await executor.run(task(["verification"]), settings, groupIr());
    const terminal = records.findLast((entry) => entry.workflowStepId === "verification");
    expect(terminal).toMatchObject({ status: "failed", output: "testCommand: timed-out" });
    expect(terminal).not.toHaveProperty("notRunReason");
  });
});
