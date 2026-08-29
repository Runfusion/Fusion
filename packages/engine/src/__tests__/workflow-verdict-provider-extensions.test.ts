// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
  type TaskDetail,
  type WorkflowIr,
} from "@fusion/core";
import { TaskExecutor } from "../executor.js";

describe("workflow verdict-provider extensions", () => {
  afterEach(() => {
    __resetWorkflowExtensionRegistryForTests();
  });

  function makeExecutor(workflow: WorkflowIr) {
    const store = {
      on: vi.fn(),
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "custom-workflow", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ ir: workflow }),
    };
    return new TaskExecutor(store as any, "/tmp/fusion-verdict-provider-test");
  }

  it("allows task completion when all provider verdicts pass", async () => {
    const workflow: WorkflowIr = { version: "v2", name: "w", columns: [], nodes: [], edges: [] };
    const task = { id: "FN-PASS", steps: [] } as unknown as TaskDetail;
    getWorkflowExtensionRegistry().register("verdict-plugin", {
      extensionId: "quality",
      name: "Quality",
      kind: "verdict-provider",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      evaluate: vi.fn().mockResolvedValue({ status: "pass", summary: "ok" }),
    });

    await expect((makeExecutor(workflow) as any).evaluateTaskVerdictProviders(task)).resolves.toEqual({ ok: true });
  });

  it("blocks task completion when a provider returns a failing verdict", async () => {
    const workflow: WorkflowIr = { version: "v2", name: "w", columns: [], nodes: [], edges: [] };
    const task = { id: "FN-BLOCK", steps: [] } as unknown as TaskDetail;
    getWorkflowExtensionRegistry().register("verdict-plugin", {
      extensionId: "quality",
      name: "Quality",
      kind: "verdict-provider",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      evaluate: vi.fn().mockResolvedValue({
        status: "fail",
        summary: "quality gate failed",
        failureReasons: [{ code: "missing-test", message: "missing regression test" }],
      }),
    });

    await expect((makeExecutor(workflow) as any).evaluateTaskVerdictProviders(task)).resolves.toEqual({
      ok: false,
      message: "fn_task_done refused (verdict-provider): quality gate failed — missing regression test",
    });
  });
});
