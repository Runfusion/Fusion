/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7739 — `fn mcp *` must retry the project-scope
 * `updateSettings` board write through a momentarily-locked SQLite board
 * database instead of surfacing a raw `database is locked` error, and must
 * close BOTH the cached project `TaskStore` and the ad-hoc uncached MCP
 * secrets `TaskStore` (the `getSecretsStore` CWD-fallback branch) on every
 * exit path so the CLI process exits promptly. Fast, fake-timer based, no
 * real waits per FN-5048.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/core", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/core")>();
  return {
    ...actual,
    // FNXC:PostgresCutover 2026-07-10: PG startup factory consulted before legacy TaskStore; null keeps the legacy mock path.
    createTaskStoreForBackend: vi.fn(async () => null),
  };
});

function makeGlobalStore(overrides: Record<string, unknown> = {}) {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn(async () => ({ mcpServers: { enabled: false, servers: [] } })),
    updateSettings: vi.fn(async (patch: any) => patch),
    ...overrides,
  };
}

function makeProjectStore(overrides: Record<string, unknown> = {}) {
  return {
    getSettingsByScope: vi.fn(async () => ({
      global: { mcpServers: { enabled: false, servers: [] } },
      project: { mcpServers: { enabled: false, servers: [] } },
    })),
    updateSettings: vi.fn(async (patch: any) => patch),
    getSecretsStore: vi.fn(async () => makeSecretsStore()),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSecretsStore(overrides: Record<string, unknown> = {}) {
  return {
    getSecretMetadata: vi.fn(() => null),
    listSecrets: vi.fn(() => []),
    createSecret: vi.fn(async (input: any) => ({ id: "sec-1", ...input })),
    ...overrides,
  };
}

async function loadWithMocks(opts: {
  projectStore?: Record<string, unknown> | null;
  globalStore?: Record<string, unknown>;
  uncachedSecretsStore?: Record<string, unknown>;
}) {
  const globalStore = opts.globalStore ?? makeGlobalStore();
  const closeProjectStore = vi.fn(async (context: { store: { close?: () => Promise<void> } }) => {
    await context.store.close?.().catch(() => {});
  });
  const asLocalProjectContext = vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  }));

  const projectContext = opts.projectStore
    ? {
        projectId: "proj_test",
        projectPath: "/proj",
        projectName: "proj",
        isRegistered: true,
        store: opts.projectStore,
      }
    : undefined;

  const resolveProject = projectContext
    ? vi.fn().mockResolvedValue(projectContext)
    : vi.fn().mockRejectedValue(new Error("no registered project"));

  const uncachedSecretsStoreClose = vi.fn().mockResolvedValue(undefined);
  const uncachedSecretsInstance = opts.uncachedSecretsStore ?? {
    init: vi.fn().mockResolvedValue(undefined),
    close: uncachedSecretsStoreClose,
    getSecretsStore: vi.fn(async () => makeSecretsStore()),
  };

  // FNXC:PostgresCutover 2026-07-10: the branch's mcp cwd fallback boots its
  // ad-hoc secrets store via createLocalStore (PG startup factory).
  vi.doMock("../../project-context.js", () => ({ resolveProject, closeProjectStore, asLocalProjectContext, createLocalStore: vi.fn(async () => uncachedSecretsInstance as never) }));

  vi.doMock("@fusion/core", async (importActual) => {
    const actual = await importActual<typeof import("@fusion/core")>();
    return {
      ...actual,
      GlobalSettingsStore: vi.fn(function GlobalSettingsStore() {
        return globalStore;
      }),
      TaskStore: vi.fn(function TaskStore() {
        return uncachedSecretsInstance;
      }),
    };
  });

  const mod = await import("../mcp.js");
  return { mod, closeProjectStore, resolveProject, globalStore, uncachedSecretsInstance, uncachedSecretsStoreClose };
}

describe("fn mcp * — lock retry and cached+uncached store teardown (FN-7739)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../project-context.js");
    vi.doUnmock("@fusion/core");
    vi.restoreAllMocks();
    delete process.env.FUSION_CLI_LOCK_RETRY_MS;
  });

  it("runMcpList: succeeds on first attempt and closes the cached project store once", async () => {
    const projectStore = makeProjectStore();
    const { mod, closeProjectStore } = await loadWithMocks({ projectStore });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mod.runMcpList({ json: true });

    expect(projectStore.getSettingsByScope).toHaveBeenCalledTimes(1);
    expect(closeProjectStore).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("runMcpAdd: retries project-scope updateSettings through a transient lock error and succeeds once it clears, then closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
      const lockError = new Error("database is locked");
      const updateSettings = vi.fn().mockImplementationOnce(() => {
        throw lockError;
      }).mockImplementation(async (patch: any) => patch);
      const projectStore = makeProjectStore({ updateSettings });
      const { mod, closeProjectStore } = await loadWithMocks({ projectStore });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const promise = mod.runMcpAdd("github", { scope: "project", transport: "stdio", command: "gh-mcp" });
      for (let i = 0; i < 10 && updateSettings.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;

      expect(updateSettings.mock.calls.length).toBeGreaterThan(1);
      expect(closeProjectStore).toHaveBeenCalled();
      logSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runMcpEdit: bounded exhaustion on a persistently locked updateSettings fails clearly and closes the store", async () => {
    vi.useFakeTimers();
    try {
      process.env.FUSION_CLI_LOCK_RETRY_MS = "500";
      const updateSettings = vi.fn().mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      const projectStore = makeProjectStore({
        getSettingsByScope: vi.fn(async () => ({
          global: { mcpServers: { enabled: false, servers: [] } },
          project: { mcpServers: { enabled: false, servers: [{ name: "github", transport: "stdio", command: "gh" }] } },
        })),
        updateSettings,
      });
      const { mod, closeProjectStore } = await loadWithMocks({ projectStore });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);

      const promise = mod.runMcpEdit("github", { scope: "project", command: "gh2" });
      const assertion = expect(promise).rejects.toThrow(/process\.exit\(1\)/);
      for (let i = 0; i < 10 && updateSettings.mock.calls.length < 2; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(updateSettings.mock.calls.length).toBeGreaterThan(1);
      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toMatch(/locked|FUSION_CLI_LOCK_RETRY_MS/i);
      expect(closeProjectStore).toHaveBeenCalled();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runMcpAdd: a not-found/validation error does not retry-loop and closes the store", async () => {
    const projectStore = makeProjectStore({
      getSettingsByScope: vi.fn(async () => ({
        global: { mcpServers: { enabled: false, servers: [] } },
        project: { mcpServers: { enabled: false, servers: [{ name: "github", transport: "stdio", command: "gh" }] } },
      })),
    });
    const { mod, closeProjectStore } = await loadWithMocks({ projectStore });

    await expect(mod.runMcpAdd("github", { scope: "project", transport: "stdio", command: "gh2" })).rejects.toThrow(/already exists/);

    expect(projectStore.updateSettings).not.toHaveBeenCalled();
    expect(closeProjectStore).toHaveBeenCalled();
  });

  it("runMcpAdd (no project — uncached secrets store): closes both the cached project store (absent) and the ad-hoc secrets store", async () => {
    const uncachedSecretsStoreClose = vi.fn().mockResolvedValue(undefined);
    const uncachedSecretsInstance = {
      init: vi.fn().mockResolvedValue(undefined),
      close: uncachedSecretsStoreClose,
      getSecretsStore: vi.fn(async () => makeSecretsStore()),
    };
    const { mod, closeProjectStore } = await loadWithMocks({ projectStore: null, uncachedSecretsStore: uncachedSecretsInstance });

    // Global-scope add does not require a project and does not touch getSecretsStore
    // unless secrets are involved; use env creation to exercise the ad-hoc secrets store.
    await mod.runMcpAdd("github", {
      scope: "global",
      transport: "stdio",
      command: "gh-mcp",
      createEnv: ["TOKEN=raw-secret-value"],
    });

    expect(uncachedSecretsInstance.getSecretsStore).toHaveBeenCalled();
    expect(uncachedSecretsStoreClose).toHaveBeenCalled();
    // closeProjectStore is invoked for the ad-hoc secrets store via asLocalProjectContext,
    // even though no cached project store exists.
    expect(closeProjectStore).toHaveBeenCalled();
  });
});
