import { afterEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => {
  const events: string[] = [];
  const project = { id: "proj-1", name: "demo", path: "/repo", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" };
  const layer = {};
  const store = {
    getAsyncLayer: vi.fn(() => layer),
    close: vi.fn(async () => { events.push("store-close"); }),
  };
  const centralClose = vi.fn(async () => { events.push("central-close"); });
  const backendShutdown = vi.fn(async () => {
    events.push("backend-shutdown");
    await store.close();
  });
  return { events, project, layer, store, centralClose, backendShutdown };
});

vi.mock("@fusion/core", () => ({
  CentralCore: class {
    init = vi.fn(async () => undefined);
    close = lifecycle.centralClose;
    getProject = vi.fn(async (id: string) => id === lifecycle.project.id ? lifecycle.project : undefined);
    listProjects = vi.fn(async () => [lifecycle.project]);
    getProjectByPath = vi.fn(async () => lifecycle.project);
  },
  GlobalSettingsStore: class {
    init = vi.fn(async () => undefined);
    getSettings = vi.fn(async () => ({}));
    updateSettings = vi.fn(async () => undefined);
  },
  createTaskStoreForBackend: vi.fn(async () => ({
    taskStore: lifecycle.store,
    asyncLayer: lifecycle.layer,
    backend: { mode: "embedded" },
    shutdown: lifecycle.backendShutdown,
  })),
  hasProjectIdentity: vi.fn(() => true),
  isValidSqliteDatabaseFile: vi.fn(() => false),
}));

import { clearStoreCache, closeProjectStore, resolveAgentStoreBase, resolveProject } from "../project-context.js";

describe("project-context PostgreSQL ownership", () => {
  afterEach(async () => {
    await clearStoreCache();
    lifecycle.events.length = 0;
    vi.clearAllMocks();
  });

  it("keeps the CentralCore-owned postmaster alive until the returned store is closed", async () => {
    const context = await resolveProject("proj-1", "/repo");

    expect(lifecycle.centralClose).not.toHaveBeenCalled();
    expect(context.store.getAsyncLayer()).toBe(lifecycle.layer);

    await closeProjectStore(context);
    await closeProjectStore(context);

    expect(lifecycle.backendShutdown).toHaveBeenCalledTimes(1);
    expect(lifecycle.centralClose).toHaveBeenCalledTimes(1);
    expect(lifecycle.events).toEqual(["backend-shutdown", "store-close", "central-close"]);
  });

  it("surfaces resolution failures instead of returning a null agent layer", async () => {
    await expect(resolveAgentStoreBase("missing")).rejects.toThrow("not found");
  });
});
