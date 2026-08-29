// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
  type TaskDetail,
  type WorkflowIr,
} from "@fusion/core";
import { evaluateAutoMergeFactProviders } from "../merge/auto-merge-fact-providers.js";

describe("auto-merge fact providers", () => {
  afterEach(() => {
    __resetWorkflowExtensionRegistryForTests();
  });

  it("collects facts and chooses the strictest route", async () => {
    const workflow: WorkflowIr = { version: "v2", name: "w", columns: [], nodes: [], edges: [] };
    const task = { id: "FN-MERGE" } as TaskDetail;
    const store = {
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "custom-workflow", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ ir: workflow }),
    };
    getWorkflowExtensionRegistry().register("merge-plugin", {
      extensionId: "facts",
      name: "Facts",
      kind: "merge-fact-provider",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      collect: vi.fn().mockResolvedValue({
        route: "manual-required",
        facts: { needsOwner: true },
        reason: "owner approval required",
      }),
    });
    getWorkflowExtensionRegistry().register("merge-plugin", {
      extensionId: "blocker",
      name: "Blocker",
      kind: "merge-fact-provider",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      collect: vi.fn().mockResolvedValue({
        route: "blocked",
        facts: { risk: "high" },
        reason: "risk gate blocked",
      }),
    });

    await expect(evaluateAutoMergeFactProviders(store, task)).resolves.toEqual({
      route: "blocked",
      facts: {
        "plugin:merge-plugin:facts": { needsOwner: true },
        "plugin:merge-plugin:blocker": { risk: "high" },
      },
      reasons: ["owner approval required", "risk gate blocked"],
    });
  });
});
