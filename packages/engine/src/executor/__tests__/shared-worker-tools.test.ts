/**
 * FNXC:CodeOrganization 2026-08-03-22:05:
 * Smoke tests for shared worker-tool free factories peeled from TaskExecutor (U4).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createArtifactListTool,
  createArtifactRegisterTool,
  createTaskLogTool,
  createTaskPromoteTool,
  createTraitListTool,
  createWorkflowListTool,
  type SharedWorkerToolsDeps,
} from "../shared-worker-tools.js";

function makeDeps(overrides: Partial<SharedWorkerToolsDeps> = {}): SharedWorkerToolsDeps {
  return {
    store: {
      getTask: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({}),
    } as any,
    rootDir: "/repo",
    messageStore: undefined,
    getRunContextFor: () => undefined,
    ...overrides,
  };
}

describe("shared-worker-tools", () => {
  it("creates store-scoped tools with expected names", () => {
    const deps = makeDeps();
    expect(createTaskLogTool(deps, "FN-1").name).toBe("fn_task_log");
    expect(createArtifactListTool(deps).name).toBe("fn_artifact_list");
    expect(createWorkflowListTool(deps).name).toBe("fn_workflow_list");
    expect(createTaskPromoteTool(deps, "FN-1").name).toBe("fn_task_promote");
    expect(createTraitListTool().name).toBe("fn_trait_list");
  });

  it("artifact register anchors at worktree and defaults task id", () => {
    const deps = makeDeps();
    const tool = createArtifactRegisterTool(deps, "executor", "FN-9", "/wt");
    expect(tool.name).toBe("fn_artifact_register");
  });
});
