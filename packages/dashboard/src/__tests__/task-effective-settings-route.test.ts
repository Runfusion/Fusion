// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request } from "../test-request.js";

class MockStore extends EventEmitter {
  private workflowSelections = new Map<string, { workflowId: string; stepIds: string[] }>();
  private workflowValues = new Map<string, Record<string, unknown>>();

  getRootDir(): string { return "/repo"; }
  getFusionDir(): string { return "/repo/.fusion"; }
  // FNXC:PostgresCutover 2026-07-16-06:55: server setup probes the async
  // layer, so this route double exposes the production-shaped backend seam.
  getAsyncLayer = vi.fn(() => ({
    db: {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
        })),
      })),
    },
  }));
  getSettings = vi.fn(async () => this.getSettingsFast());
  getSettingsFast = vi.fn(async (): Promise<Settings> => ({
    defaultProvider: "base-default-provider",
    defaultModelId: "base-default-model",
    workflowStepTimeoutMs: 900_000,
    runStepsInNewSessions: false,
  } as Settings));
  getTaskWorkflowSelection = vi.fn((taskId: string) => this.workflowSelections.get(taskId));
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn((workflowId: string, projectId: string) => this.workflowValues.get(`${workflowId}::${projectId}`) ?? {});
  getWorkflowSettingsProjectId = vi.fn(() => "default");

  setSelection(taskId: string, workflowId: string): void {
    this.workflowSelections.set(taskId, { workflowId, stepIds: [] });
  }

  setValues(workflowId: string, values: Record<string, unknown>): void {
    this.workflowValues.set(`${workflowId}::default`, values);
  }
}

function createApp(store = new MockStore()) {
  return { app: createServer(store as unknown as TaskStore), store };
}

describe("GET /tasks/:id/effective-settings", () => {
  it("overlays stored workflow model lanes that base settings do not expose", async () => {
    const { app, store } = createApp();
    store.setSelection("FN-1", "builtin:coding");
    store.setValues("builtin:coding", {
      executionProvider: "openai",
      executionModelId: "gpt-4o",
      validatorProvider: "anthropic",
      validatorModelId: "claude-3-7-sonnet",
      planningProvider: "google",
      planningModelId: "gemini-2.5-pro",
    });

    const base = await request(app, "GET", "/api/settings");
    expect(base.status).toBe(200);
    expect(base.body).not.toHaveProperty("executionProvider");
    expect(base.body).not.toHaveProperty("validatorProvider");
    expect(base.body).not.toHaveProperty("planningProvider");

    const effective = await request(app, "GET", "/api/tasks/FN-1/effective-settings");
    expect(effective.status).toBe(200);
    expect(effective.body).toMatchObject({
      executionProvider: "openai",
      executionModelId: "gpt-4o",
      validatorProvider: "anthropic",
      validatorModelId: "claude-3-7-sonnet",
      planningProvider: "google",
      planningModelId: "gemini-2.5-pro",
    });
  });

  it("keeps default-only workflow settings from clobbering base values", async () => {
    const { app, store } = createApp();
    store.setSelection("FN-2", "builtin:coding");
    store.getSettingsFast.mockResolvedValueOnce({ workflowStepTimeoutMs: 12_345 } as Settings);

    const effective = await request(app, "GET", "/api/tasks/FN-2/effective-settings");
    expect(effective.status).toBe(200);
    expect(effective.body).toMatchObject({ workflowStepTimeoutMs: 12_345 });
    expect(effective.body).not.toHaveProperty("executionProvider");
  });

  it("falls through to base/default settings when no stored workflow lane exists", async () => {
    const { app, store } = createApp();
    store.setSelection("FN-3", "builtin:coding");

    const effective = await request(app, "GET", "/api/tasks/FN-3/effective-settings");
    expect(effective.status).toBe(200);
    expect(effective.body).toMatchObject({
      defaultProvider: "base-default-provider",
      defaultModelId: "base-default-model",
    });
    expect(effective.body).not.toHaveProperty("executionProvider");
  });

  it("degrades an unknown task to base-compatible effective settings", async () => {
    const { app } = createApp();

    const effective = await request(app, "GET", "/api/tasks/FN-MISSING/effective-settings");
    expect(effective.status).toBe(200);
    expect(effective.body).toMatchObject({
      defaultProvider: "base-default-provider",
      defaultModelId: "base-default-model",
    });
    expect(effective.body).not.toHaveProperty("executionProvider");
  });
});
