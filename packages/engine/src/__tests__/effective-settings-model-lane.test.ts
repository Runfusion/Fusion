import { describe, it, expect, vi } from "vitest";

import { resolveExecutionSettingsModel, type Settings } from "@fusion/core";
import { mergeEffectiveSettings } from "../effective-settings.js";

const PROJECT = "proj-1";

function makeStore(values?: Record<string, unknown>) {
  return {
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(() => values ?? {}),
    getWorkflowSettingsProjectId: vi.fn(() => PROJECT),
  };
}

/**
 * KTD-7 model-lane chain, pinned AFTER the entry merge. The chain reads
 * `settings.executionProvider` (workflow lane, now from the effective merge) →
 * `executionGlobalProvider` (stays global) → project default override → global
 * default. The entry merge feeds the workflow lane into that same field, so the
 * documented chain is unchanged.
 */
describe("model-lane resolution after effective-settings merge (KTD-7)", () => {
  it("workflow lane set → wins over global lane and defaults", async () => {
    const base = {
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
      defaultProvider: "def-prov",
      defaultModelId: "def-model",
    } as unknown as Settings;
    const merged = await mergeEffectiveSettings(
      makeStore({ executionProvider: "wf-prov", executionModelId: "wf-model" }) as any,
      { id: "t1" },
      base,
    );
    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "wf-prov", modelId: "wf-model" });
  });

  it("workflow lane empty → falls through to the global lane", async () => {
    const base = {
      executionGlobalProvider: "global-prov",
      executionGlobalModelId: "global-model",
      defaultProvider: "def-prov",
      defaultModelId: "def-model",
    } as unknown as Settings;
    // No stored workflow lane; builtin declarations omit lane defaults → lane absent.
    const merged = await mergeEffectiveSettings(makeStore() as any, { id: "t1" }, base);
    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "global-prov", modelId: "global-model" });
  });

  it("workflow + global lanes empty → falls through to the global default", async () => {
    const base = {
      defaultProvider: "def-prov",
      defaultModelId: "def-model",
    } as unknown as Settings;
    const merged = await mergeEffectiveSettings(makeStore() as any, { id: "t1" }, base);
    expect(resolveExecutionSettingsModel(merged)).toEqual({ provider: "def-prov", modelId: "def-model" });
  });
});
