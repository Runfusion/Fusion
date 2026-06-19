import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowTaskRuntime } from "../workflow-task-runtime.js";
import type { WorkflowRuntimePrimitives } from "../runtime-primitives.js";

/*
FNXC:WorkflowGates 2026-06-17-18:24:
FN-6582 requires terminal workflow success to depend on declared task-document artifact key existence, not only graph node success. Missing declared keys keep the run incomplete/failed; empty document content still counts as present because the MVP artifact contract currently requires existence.
*/

const task = { id: "FN-6582" } as TaskDetail;
const settings = { experimentalFeatures: {} } as unknown as Pick<Settings, "experimentalFeatures">;

function trivialIr(artifacts?: WorkflowIr["artifacts"]): WorkflowIr {
  return {
    version: "v1",
    name: "required-artifact-gate",
    artifacts,
    nodes: [
      { id: "start", kind: "start" },
      { id: "check", kind: "prompt", config: { prompt: "approve" } },
      { id: "zend", kind: "end" },
    ],
    edges: [
      { from: "start", to: "check", condition: "success" },
      { from: "check", to: "zend", condition: "success" },
    ],
  };
}

function primitives(): WorkflowRuntimePrimitives {
  return {
    prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: "/tmp/fusion-worktree" } }),
    readArtifact: async () => undefined,
    writeArtifact: async (_ctx, _task, key) => ({ outcome: "success", data: { key } }),
    runPlanningSession: async () => ({ outcome: "success", data: { approved: true, artifactKeys: [] } }),
    runCodingSession: async () => ({ outcome: "success", data: { taskDone: true, modifiedFiles: [] } }),
    runTaskStep: async () => ({ outcome: "success" }),
    resetTaskStep: async () => ({ ok: true }),
    runReview: async () => ({ outcome: "success", data: { verdict: "APPROVE" } }),
    runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
    runWorkflowStep: async () => ({ outcome: "success", data: { allPassed: true } }),
    updateSteps: async (_ctx, _task, steps) => ({ outcome: "success", data: { count: steps.length } }),
    transitionTask: async () => ({ outcome: "success" }),
    requestMerge: async () => ({ outcome: "success", data: { status: "merged" } }),
    abortRun: async () => ({ outcome: "success" }),
    audit: () => undefined,
  };
}

function runtimeFor(ir: WorkflowIr, docs: Map<string, string>) {
  const getTaskDocument = vi.fn(async (_taskId: string, key: string) => {
    if (!docs.has(key)) return null;
    return { taskId: task.id, key, content: docs.get(key), revision: 1 };
  });
  const runtime = new WorkflowTaskRuntime({
    store: {
      getTaskWorkflowSelection: () => ({ workflowId: "WF-6582", stepIds: [] }),
      getWorkflowDefinition: async () => ({ ir }),
      getTaskDocument,
    },
    primitives: primitives(),
    runCustomNode: async () => ({ outcome: "success" }),
  });
  return { runtime, getTaskDocument };
}

describe("workflow required-artifact terminal gate", () => {
  it("fails terminal success when a declared task-document artifact key is absent", async () => {
    const { runtime, getTaskDocument } = runtimeFor(trivialIr([{ key: "plan", role: "context" }]), new Map());

    const result = await runtime.run(task, settings);

    expect(result.disposition).toBe("failed");
    expect(result.outcome).toBe("failure");
    expect(result.reason).toBe("workflow-required-artifacts-missing:plan");
    expect(result.context["workflow:required-artifacts:missing"]).toEqual(["plan"]);
    expect(getTaskDocument).toHaveBeenCalledWith(task.id, "plan");
  });

  it("completes when every declared task-document artifact key exists, including whitespace content", async () => {
    const ir = trivialIr([
      { key: "plan", role: "step-source" },
      { key: "evidence", role: "context" },
    ]);
    const { runtime } = runtimeFor(ir, new Map([
      ["plan", "   \n"],
      ["evidence", "coverage summary"],
    ]));

    const result = await runtime.run(task, settings);

    expect(result.disposition).toBe("completed");
    expect(result.outcome).toBe("success");
    expect(result.context["workflow:required-artifacts:missing"]).toBeUndefined();
  });

  it("reports all missing keys for multi-artifact workflows", async () => {
    const ir = trivialIr([
      { key: "plan", role: "step-source" },
      { key: "evidence", role: "context" },
      { key: "release-notes", role: "context" },
    ]);
    const { runtime } = runtimeFor(ir, new Map([["evidence", "present"]]));

    const result = await runtime.run(task, settings);

    expect(result.disposition).toBe("failed");
    expect(result.reason).toBe("workflow-required-artifacts-missing:plan,release-notes");
    expect(result.context["workflow:required-artifacts:missing"]).toEqual(["plan", "release-notes"]);
  });

  it("does not require the implicit PROMPT.md artifact when no artifacts are declared", async () => {
    const { runtime, getTaskDocument } = runtimeFor(trivialIr(undefined), new Map());

    const result = await runtime.run(task, settings);

    expect(result.disposition).toBe("completed");
    expect(result.outcome).toBe("success");
    expect(getTaskDocument).not.toHaveBeenCalled();
  });
});
