import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../config/settings-schema.js";
import { BUILTIN_OVERSIGHT_SETTINGS, BUILTIN_WORKFLOW_SETTINGS, MEMORY_CONSOLIDATION_ENABLED_SETTING_ID } from "../workflows/builtin-workflow-settings.js";
import { resolveEffectiveMemoryConsolidationEnabled, resolveEffectiveSettingsById, type WorkflowSettingsResolverStore } from "../workflows/workflow-settings-resolver.js";

function store(values: Record<string, unknown> = {}): WorkflowSettingsResolverStore {
  return { getTaskWorkflowSelection: vi.fn(() => undefined), getWorkflowDefinition: vi.fn(async () => undefined), getWorkflowSettingValues: vi.fn(() => values), getWorkflowSettingsProjectId: vi.fn(() => "project") };
}

describe("memoryConsolidationEnabled workflow setting", () => {
  it("is a default-on workflow-native oversight setting", () => {
    expect(BUILTIN_OVERSIGHT_SETTINGS.find((setting) => setting.id === MEMORY_CONSOLIDATION_ENABLED_SETTING_ID)).toMatchObject({ type: "boolean", default: true, name: "Memory consolidation enabled" });
    expect(BUILTIN_WORKFLOW_SETTINGS.some((setting) => setting.id === MEMORY_CONSOLIDATION_ENABLED_SETTING_ID)).toBe(true);
    expect(DEFAULT_PROJECT_SETTINGS).not.toHaveProperty(MEMORY_CONSOLIDATION_ENABLED_SETTING_ID);
  });

  it("defaults on, honors explicit false, and treats garbage as enabled", async () => {
    expect(resolveEffectiveMemoryConsolidationEnabled(await resolveEffectiveSettingsById(store(), "builtin:coding", "project"))).toBe(true);
    expect(resolveEffectiveMemoryConsolidationEnabled(await resolveEffectiveSettingsById(store({ memoryConsolidationEnabled: false }), "builtin:coding", "project"))).toBe(false);
    expect(resolveEffectiveMemoryConsolidationEnabled({ memoryConsolidationEnabled: "false" })).toBe(true);
  });
});
