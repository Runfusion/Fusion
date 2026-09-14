import { describe, expect, it, vi } from "vitest";
import { resolvePlanningSettingsModel } from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";

/*
FNXC:WorkflowIdentity 2026-09-14-19:06:
Project model configuration must survive workflow selection/default changes. This exercises
engine composition, not just a fabricated selectedWorkflowModelLanes value.
*/
describe("project model lane identity independence", () => {
  it.each(["builtin:coding", "builtin:coding-ideas", "builtin:quick-fix"])(
    "keeps the project Planner with default workflow %s",
    async (defaultWorkflowId) => {
      const store = {
        getDefaultWorkflowId: vi.fn(async () => defaultWorkflowId),
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding-ideas", stepIds: [] }),
        getWorkflowDefinition: vi.fn(async () => undefined),
        getWorkflowSettingsProjectId: () => "project-models",
        getWorkflowSettingValues: vi.fn(() => ({})),
      };
      const effective = await mergeEffectiveSettings(store as never, { id: "FN-MODELS" }, {
        defaultProvider: "global-provider", defaultModelId: "global-model",
        planningProvider: "anthropic", planningModelId: "claude-opus-5",
      });
      expect(resolvePlanningSettingsModel(effective)).toMatchObject({ provider: "anthropic", modelId: "claude-opus-5" });
    },
  );

  it("lets the selected non-default workflow override the project without flattening its lane", async () => {
    const getDefaultWorkflowId = vi.fn(async () => "builtin:coding");
    const store = {
      getDefaultWorkflowId,
      getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding-ideas", stepIds: [] }),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingsProjectId: () => "project-models",
      getWorkflowSettingValues: vi.fn((id: string) => id === "builtin:coding-ideas"
        ? { planningProvider: "workflow-provider", planningModelId: "workflow-model" }
        : {}),
    };
    const effective = await mergeEffectiveSettings(store as never, { id: "FN-MODELS" }, {
      defaultProvider: "global-provider", defaultModelId: "global-model",
      planningProvider: "project-provider", planningModelId: "project-model",
    });
    expect(effective.planningProvider).toBe("project-provider");
    expect(resolvePlanningSettingsModel(effective)).toMatchObject({ provider: "workflow-provider", modelId: "workflow-model" });
    expect(getDefaultWorkflowId).not.toHaveBeenCalled();
  });
});
