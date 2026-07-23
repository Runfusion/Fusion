import { describe, expect, it, vi } from "vitest";

import { BUILTIN_WORKFLOW_SETTINGS, type Settings } from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";

const PROJECT = "proj-1";

function baseSettings(): Settings {
  const catalogDefaults = Object.fromEntries(
    BUILTIN_WORKFLOW_SETTINGS
      .filter((setting) => setting.default !== undefined)
      .map((setting) => [setting.id, setting.default]),
  );
  return {
    ...catalogDefaults,
    persistAgentToolOutput: false,
    executionProvider: "project-anthropic",
    executionModelId: "claude-project",
  } as unknown as Settings;
}

describe("merger settings degrade path", () => {
  it("uses a fallback task id so deleted-task getTask failures still return base settings", async () => {
    const taskId = "FN-6193-DELETED";
    const store = {
      getTask: vi.fn(async () => {
        throw new Error(`Task ${taskId} not found`);
      }),
      getTaskWorkflowSelection: vi.fn(() => {
        throw new Error(`Task ${taskId} not found`);
      }),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(() => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => PROJECT),
    };
    const base = baseSettings();

    const taskForSettings = await store.getTask(taskId).catch(() => ({ id: taskId } as const));
    const merged = await mergeEffectiveSettings(store as any, taskForSettings, base);

    expect(merged).toEqual(base);
  });
});
