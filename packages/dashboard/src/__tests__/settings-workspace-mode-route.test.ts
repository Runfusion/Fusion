import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Router } from "express";

const persistence = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("../../../core/src/task-store/async/async-settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/src/task-store/async/async-settings.js")>();
  return { ...actual, readProjectConfig: persistence.read, writeProjectConfig: persistence.write };
});
vi.mock("../../../core/src/task-store/async-stores/async-configuration-revision-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/src/task-store/async-stores/async-configuration-revision-store.js")>();
  return { ...actual, appendConfigurationRevision: vi.fn(async () => undefined) };
});
import { TaskStore } from "../../../core/src/store.js";
import { __setWorkspaceModeOpsForTesting } from "../../../core/src/task-store/settings-ops.js";
import { loadWorkspaceConfig } from "../../../core/src/git/git-repository.js";
import { registerSettingsMemoryRoutes } from "../routes/register-settings-memory-routes.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 10_000 });
}

async function addRepository(rootDir: string, name: string): Promise<void> {
  const repository = join(rootDir, name);
  mkdirSync(repository, { recursive: true });
  await git(repository, ["init", "-b", "main"]);
}

function createProductionStore(rootDir: string): TaskStore {
  const layer = {
    projectId: "workspace-route-test",
    transactionImmediate: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      insert: () => ({ values: async () => undefined }),
    }),
  };
  const store = new TaskStore(rootDir, undefined, { asyncLayer: layer as never });
  store.globalSettingsStore.getSettings = vi.fn(async () => ({}));
  return store;
}

function setup(rootDir: string, store = createProductionStore(rootDir)) {
  const handlers = new Map<string, (req: { body: Record<string, unknown> }, res: { json: (value: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn(), post: vi.fn(), delete: vi.fn(),
    put: vi.fn((path: string, handler: (req: { body: Record<string, unknown> }, res: { json: (value: unknown) => void }) => Promise<void>) => handlers.set(path, handler)),
  } as unknown as Router;
  registerSettingsMemoryRoutes({
    router,
    store: {} as never,
    options: { engineManager: { getAllEngines: () => new Map() } } as never,
    runtimeLogger: { warn: vi.fn() } as never,
    getProjectContext: vi.fn(async () => ({ store })),
    rethrowAsApiError: (error: unknown): never => { throw error; },
  } as never, {
    validateModelPresets: () => undefined,
    sanitizeBooleanSetting: () => undefined,
    sanitizeOverlapIgnorePaths: () => undefined,
    discoverDashboardPiExtensions: async () => ({ entries: [] }) as never,
  });
  return { put: handlers.get("/settings")!, store };
}

beforeEach(() => {
  persistence.settings = {};
  persistence.read.mockReset();
  persistence.write.mockReset();
  persistence.read.mockImplementation(async () => ({ nextId: 1, nextWorkflowStepId: 1, nextWorkflowDefinitionId: 1, settings: { ...persistence.settings } }));
  persistence.write.mockImplementation(async (_layer: unknown, settings: Record<string, unknown>) => { persistence.settings = { ...settings }; });
  __setWorkspaceModeOpsForTesting(undefined);
});
afterEach(() => {
  __setWorkspaceModeOpsForTesting(undefined);
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fusion-workspace-route-"));
  roots.push(value);
  return value;
}

/*
FNXC:Workspace 2026-08-15-06:11:
These route tests deliberately use TaskStore.updateSettings rather than a mocked update method.
The route is only proven when its JSON response crosses the production commit, publish, disk
reconciliation, and returned-snapshot seam; a mocked corrected response cannot establish that.
*/
describe("PUT /settings workspace mode", () => {
  it("returns a client error and does not write when enabling has no sub-repositories", async () => {
    const rootDir = root();
    const { put } = setup(rootDir);
    await expect(put({ body: { workspaceMode: true } }, { json: vi.fn() })).rejects.toMatchObject({ statusCode: 400 });
    expect(persistence.write).not.toHaveBeenCalled();
  });

  it("runs the real settings publish seam to enable and disable workspace mode", async () => {
    const rootDir = root();
    await addRepository(rootDir, "repo-a");
    await addRepository(rootDir, "repo-b");
    const { put } = setup(rootDir);
    const enabledJson = vi.fn();

    await put({ body: { workspaceMode: true } }, { json: enabledJson });

    expect((enabledJson.mock.calls[0]![0] as { workspaceMode: boolean }).workspaceMode).toBe(true);
    expect(persistence.settings.workspaceMode).toBe(true);
    expect((await loadWorkspaceConfig(rootDir))?.repos).toEqual(["repo-a", "repo-b"]);

    const disabledJson = vi.fn();
    await put({ body: { workspaceMode: false } }, { json: disabledJson });

    expect((disabledJson.mock.calls[0]![0] as { workspaceMode: boolean }).workspaceMode).toBe(false);
    expect(persistence.settings.workspaceMode).toBe(false);
    expect(await loadWorkspaceConfig(rootDir)).toBeNull();
  });

  it("returns the real publish seam's reconciled failed-disable snapshot", async () => {
    const rootDir = root();
    mkdirSync(join(rootDir, ".fusion"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion", "workspace.json"), JSON.stringify({ repos: ["repo-a"] }));
    persistence.settings = { workspaceMode: true };
    __setWorkspaceModeOpsForTesting({
      removeWorkspaceConfig: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    });
    const { put } = setup(rootDir);
    const json = vi.fn();

    await put({ body: { workspaceMode: false } }, { json });

    expect((json.mock.calls[0]![0] as { workspaceMode: boolean }).workspaceMode).toBe(true);
    expect(persistence.settings.workspaceMode).toBe(true);
    expect((await loadWorkspaceConfig(rootDir))?.repos).toEqual(["repo-a"]);
    expect(JSON.parse(readFileSync(join(rootDir, ".fusion", "config.json"), "utf8"))).toMatchObject({
      settings: { workspaceMode: true },
    });
  });
});
