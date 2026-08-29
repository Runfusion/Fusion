import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  reads: 0,
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock("../task-store/async/async-settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-store/async/async-settings.js")>();
  return {
    ...actual,
    readProjectConfig: config.read,
    writeProjectConfig: config.write,
  };
});

import { publishSettingsUpdated } from "../task-store/settings-ops.js";
import { TaskStore } from "../store.js";
import { loadWorkspaceConfig } from "../git/git-repository.js";

const workspaceToggle = vi.hoisted(() => ({ result: null as { enabled: boolean | undefined; repos: string[]; workspaceConfigWritten: boolean; workspaceConfigRemoved: boolean; failureReason?: string } | null }));

vi.mock("../git/git-repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/git-repository.js")>();
  return {
    ...actual,
    applyWorkspaceModeToggle: (...args: Parameters<typeof actual.applyWorkspaceModeToggle>) =>
      workspaceToggle.result ?? actual.applyWorkspaceModeToggle(...args),
  };
});

vi.mock("../async-stores/async-configuration-revision-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../async-stores/async-configuration-revision-store.js")>();
  return { ...actual, appendConfigurationRevision: vi.fn(async () => undefined) };
});

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "fusion-settings-workspace-"));
  roots.push(value);
  return value;
};
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function store(rootDir: string) {
  return { rootDir, asyncLayer: { projectId: "test" }, emit: vi.fn() } as never;
}

function productionStore(rootDir: string): TaskStore {
  const layer = {
    projectId: "test",
    transactionImmediate: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  };
  const taskStore = new TaskStore(rootDir, undefined, { asyncLayer: layer as never });
  taskStore.globalSettingsStore.getSettings = vi.fn(async () => ({}));
  return taskStore;
}

beforeEach(() => {
  workspaceToggle.result = null;
  config.settings = {};
  config.reads = 0;
  config.read.mockReset();
  config.write.mockReset();
  config.read.mockImplementation(async () => ({ nextId: 1, nextWorkflowStepId: 1, nextWorkflowDefinitionId: 1, settings: { ...config.settings } }));
  config.write.mockImplementation(async (_layer: unknown, settings: Record<string, unknown>) => { config.settings = { ...settings }; });
});

/*
FNXC:Workspace 2026-08-15-05:54:
The universal post-commit seam must be tested independently of the dashboard route. Rollback,
CLI, and MCP writers do not receive route validation, so disk state, the corrected persisted field,
and the emitted snapshot must agree before listeners run.
*/
describe("publishSettingsUpdated workspace reconciliation", () => {
  it("returns the reconciled value through the production updateSettings commit and publish path", async () => {
    const rootDir = root();
    const taskStore = productionStore(rootDir);
    const emitted: Array<{ settings: { workspaceMode?: boolean } }> = [];
    taskStore.on("settings:updated", (payload) => emitted.push(payload));
    workspaceToggle.result = {
      enabled: false,
      repos: [],
      workspaceConfigWritten: false,
      workspaceConfigRemoved: false,
      failureReason: "workspace-config-write-failed: EACCES",
    };

    const returned = await taskStore.updateSettings({ workspaceMode: true });

    expect(returned.workspaceMode).toBe(false);
    expect(config.settings.workspaceMode).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.settings.workspaceMode).toBe(false);
  });

  it("applies enable and disable through the production updateSettings commit and publish path", async () => {
    const rootDir = root();
    mkdirSync(join(rootDir, ".fusion"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion", "workspace.json"), JSON.stringify({ repos: ["curated-repo"] }));
    const taskStore = productionStore(rootDir);

    const enabled = await taskStore.updateSettings({ workspaceMode: true });
    expect(enabled.workspaceMode).toBe(true);
    expect(config.settings.workspaceMode).toBe(true);
    expect((await loadWorkspaceConfig(rootDir))?.repos).toEqual(["curated-repo"]);

    const disabled = await taskStore.updateSettings({ workspaceMode: false });
    expect(disabled.workspaceMode).toBe(false);
    expect(config.settings.workspaceMode).toBe(false);
    expect(await loadWorkspaceConfig(rootDir)).toBeNull();
  });

  it("corrects a non-dashboard zero-repository enable before settings:updated emits", async () => {
    const rootDir = root();
    config.settings = { workspaceMode: true };
    const taskStore = store(rootDir);
    const settings = { workspaceMode: true } as never;

    await publishSettingsUpdated(taskStore, { workspaceMode: false } as never, settings);

    expect(config.write).toHaveBeenCalledTimes(1);
    expect(config.settings.workspaceMode).toBe(false);
    expect(settings.workspaceMode).toBe(false);
    expect(existsSync(join(rootDir, ".fusion", "workspace.json"))).toBe(false);
    expect(taskStore.emit).toHaveBeenCalledWith("settings:updated", {
      settings, previous: { workspaceMode: false },
    });
  });

  it("reconciles a failed disable before emit without clobbering a concurrent setting", async () => {
    const rootDir = root();
    mkdirSync(join(rootDir, ".fusion"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion", "workspace.json"), JSON.stringify({ repos: ["repo-a"] }));
    config.settings = { workspaceMode: false };
    config.read.mockImplementation(async () => {
      config.reads += 1;
      // The first read validates this publish's committed intent; the second is a newer row.
      return { nextId: 1, nextWorkflowStepId: 1, nextWorkflowDefinitionId: 1, settings: config.reads === 1
        ? { workspaceMode: false }
        : { workspaceMode: false, taskPrefix: "concurrent" } };
    });
    const taskStore = store(rootDir);
    const settings = { workspaceMode: false } as never;

    await publishSettingsUpdated(taskStore, { workspaceMode: true } as never, settings, {
      workspaceModeOps: { removeWorkspaceConfig: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
    });

    expect((await loadWorkspaceConfig(rootDir))?.repos).toEqual(["repo-a"]);
    expect(config.write).toHaveBeenCalledWith(expect.anything(), { workspaceMode: true, taskPrefix: "concurrent" });
    expect(settings.workspaceMode).toBe(true);
    expect(taskStore.emit).toHaveBeenCalledWith("settings:updated", {
      settings, previous: { workspaceMode: true },
    });
  });

  it("abandons a superseded rollback-shaped transition without touching disk", async () => {
    const rootDir = root();
    config.settings = { workspaceMode: true };
    const taskStore = store(rootDir);
    const settings = { workspaceMode: false } as never;

    await publishSettingsUpdated(taskStore, { workspaceMode: true } as never, settings);

    expect(config.write).not.toHaveBeenCalled();
    expect(existsSync(join(rootDir, ".fusion", "workspace.json"))).toBe(false);
    expect(settings.workspaceMode).toBe(true);
    expect(taskStore.emit).toHaveBeenCalledWith("settings:updated", {
      settings, previous: { workspaceMode: true },
    });
  });
});
