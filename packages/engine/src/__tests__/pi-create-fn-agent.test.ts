import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PathLike } from "node:fs";

const createAgentSessionMock = vi.fn();
const createBashToolMock = vi.fn((cwd: string, options?: any) => ({ name: "bash", cwd, options }));
const createCodingToolsMock = vi.fn(() => []);
const createReadOnlyToolsMock = vi.fn(() => []);
const createExtensionRuntimeMock = vi.fn();
const discoverAndLoadExtensionsMock = vi.fn().mockResolvedValue({
  runtime: { pendingProviderRegistrations: [] },
  errors: [],
});
const packageManagerResolveMock = vi.fn().mockResolvedValue({ extensions: [] });
const findMock = vi.fn();
const getAllMock = vi.fn(() => [] as any[]);
const registerProviderMock = vi.fn();
const refreshMock = vi.fn();
// FNXC:SessionRouting 2026-06-24-11:30:
// #1675: capture model-runtime auth resolution + session id so the wiring
// test can assert X-Session-Id/X-Session-Affinity precedence end-to-end.
// FNXC:SessionRouting 2026-07-16-19:05: FN-8142 moved the routing-header seam from
// ModelRegistry.getApiKeyAndHeaders to ModelRuntime.getAuth; base getAuth returns a
// resolvable auth so attachSessionRoutingHeaders' header merge is observable.
const getApiKeyAndHeadersMock = vi.fn(async () => ({ ok: true, apiKey: undefined, headers: undefined }));
const modelRuntimeGetAuthMock = vi.fn(async (..._args: unknown[]) => ({ auth: { headers: {} as Record<string, string> } }));
const sessionManagerGetSessionIdMock = vi.fn(() => undefined);
const settingsManagerCreateMock = vi.fn(() => ({ kind: "settings-manager-create" }));
const settingsManagerInMemoryMock = vi.fn(() => ({ kind: "settings-manager" }));
const setFallbackResolverMock = vi.fn();
const authStorageGetApiKeyMock = vi.fn(async () => undefined);
const authStorageGetMock = vi.fn(() => undefined);
const authStorageHasMock = vi.fn(() => false);
const authStorageHasAuthMock = vi.fn(() => false);
const authStorageGetAllMock = vi.fn(() => ({}));
const authStorageListMock = vi.fn(() => []);
const reloadMock = vi.fn(async () => {});
const execSyncMock = vi.fn((_cmd?: any, _opts?: any) => "");
const spawnSyncMock = vi.fn(() => ({ status: 1, stdout: "" }));
const execFileMock = vi.fn((_file?: any, _args?: any, _opts?: any, cb?: any) => {
  const callback = typeof _opts === "function" ? _opts : cb;
  if (typeof callback === "function") callback(null, "", "");
});
const existsSyncMock = vi.fn((_path: PathLike) => false);
const readFileSyncMock = vi.fn((_path?: any) => "{}");
const realpathSyncNativeMock = vi.fn((path: PathLike) => String(path));
const readCustomProvidersMock = vi.fn(() => []);
const packageManagerCwdCapture = vi.fn();
const packageManagerSettingsCapture = vi.fn();
const resourceLoaderOptionsCapture = vi.fn();

// Route async `exec` through the `execSync` mock so the promisify bridge works.
// Use Symbol.for("nodejs.util.promisify.custom") directly to avoid async imports
// in the mock factory (which can cause occasional module-loader deadlocks).
vi.mock("node:child_process", () => {
  const execSyncFn = execSyncMock;
  const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");

  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : (opts ?? {});
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });

  execFn[kPromisifyCustom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { execSync: execSyncFn, exec: execFn, execFile: execFileMock, spawnSync: spawnSyncMock };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    realpathSync: Object.assign(vi.fn((path: PathLike) => String(path)), {
      native: realpathSyncNativeMock,
    }),
  };
});

vi.mock("../custom-providers.js", () => ({
  readCustomProviders: readCustomProvidersMock,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: {
    create: () => ({
      setFallbackResolver: setFallbackResolverMock,
      getApiKey: authStorageGetApiKeyMock,
      get: authStorageGetMock,
      set: vi.fn(),
      has: authStorageHasMock,
      hasAuth: authStorageHasAuthMock,
      getAll: authStorageGetAllMock,
      list: authStorageListMock,
      logout: vi.fn(),
      remove: vi.fn(),
      reload: vi.fn(),
    }),
  },
  createAgentSession: createAgentSessionMock,
  createBashTool: createBashToolMock,
  createCodingTools: createCodingToolsMock,
  createEditTool: () => ({ name: "edit" }),
  createExtensionRuntime: createExtensionRuntimeMock,
  createFindTool: () => ({ name: "find" }),
  createGrepTool: () => ({ name: "grep" }),
  createLsTool: () => ({ name: "ls" }),
  createReadOnlyTools: createReadOnlyToolsMock,
  createReadTool: () => ({ name: "read" }),
  createWriteTool: () => ({ name: "write" }),
  DefaultResourceLoader: class {
    constructor(options: any) {
      resourceLoaderOptionsCapture(options);
    }
    async reload() {
      await reloadMock();
    }
  },
  DefaultPackageManager: class {
    private readonly settingsManager: any;

    constructor(options: any) {
      packageManagerCwdCapture(options?.cwd);
      packageManagerSettingsCapture(options?.settingsManager);
      this.settingsManager = options?.settingsManager;
    }
    async resolve() {
      this.settingsManager.isProjectTrusted();
      return packageManagerResolveMock();
    }
  },
  discoverAndLoadExtensions: discoverAndLoadExtensionsMock,
  getAgentDir: () => "/mock-agent-dir",
  /*
  FNXC:ModelRegistry 2026-07-16-19:05:
  pi 0.80.8+ (FN-8142 migration) made model init async via ModelRuntime; createFusionModelRegistry
  now awaits ModelRuntime.create(...) before constructing the registry. The stale ^0.80.6 pin masked
  this until FN-8142's SDK bump (this PR); mock ModelRuntime so createFnAgent's registry path resolves.
  */
  ModelRuntime: {
    create: async () => ({ getAuth: modelRuntimeGetAuthMock }),
  },
  ModelRegistry: class {
    static create(...args: unknown[]) {
      return new (this as unknown as new () => unknown)();
    }
    find(provider: string, modelId: string) {
      return findMock(provider, modelId);
    }
    getAll() {
      return getAllMock();
    }
    registerProvider(name: string, config: unknown) {
      return registerProviderMock(name, config);
    }
    refresh() {
      return refreshMock();
    }
    getApiKeyAndHeaders() {
      return getApiKeyAndHeadersMock();
    }
  },
  SessionManager: {
    inMemory: () => ({ kind: "session-manager", getSessionId: sessionManagerGetSessionIdMock }),
  },
  SettingsManager: {
    create: settingsManagerCreateMock,
    inMemory: settingsManagerInMemoryMock,
  },
}));

describe("RTK bash rewrite wrapper", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file?: any, _args?: any, _opts?: any, cb?: any) => {
      const callback = typeof _opts === "function" ? _opts : cb;
      if (typeof callback === "function") callback(null, "", "");
    });
  });

  it("rewrites bash commands when rtk returns an accepted rewrite", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "rtk git status\n", "");
    });
    const bashTool = {
      name: "bash",
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };

    const { wrapToolsWithRtkRewrite } = await import("../pi.js");
    const wrapped = wrapToolsWithRtkRewrite([bashTool as any], { mode: "rewrite", timeoutMs: 100 });

    await (wrapped[0] as any).execute("call-1", { command: "git status", cwd: "/project" });

    expect(execFileMock).toHaveBeenCalledWith("rtk", ["rewrite", "git status"], expect.objectContaining({ timeout: 100 }), expect.any(Function));
    expect(bashTool.execute).toHaveBeenCalledWith("call-1", { command: "rtk git status", cwd: "/project" });
  });

  it("accepts rtk rewrite exit code 3", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: any) => {
      const err = new Error("ask") as any;
      err.code = 3;
      cb(err, "rtk ls\n", "");
    });
    const bashTool = {
      name: "bash",
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };

    const { wrapToolsWithRtkRewrite } = await import("../pi.js");
    const wrapped = wrapToolsWithRtkRewrite([bashTool as any], { mode: "rewrite", timeoutMs: 100 });

    await (wrapped[0] as any).execute("call-1", { command: "ls" });

    expect(bashTool.execute).toHaveBeenCalledWith("call-1", { command: "rtk ls" });
  });

  it("fails open when rtk is unavailable or declines a rewrite", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: any) => {
      const err = new Error("no equivalent") as any;
      err.code = 1;
      cb(err, "", "");
    });
    const bashTool = {
      name: "bash",
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };

    const { wrapToolsWithRtkRewrite } = await import("../pi.js");
    const wrapped = wrapToolsWithRtkRewrite([bashTool as any], { mode: "rewrite", timeoutMs: 100 });

    await (wrapped[0] as any).execute("call-1", { command: "git status" });

    expect(bashTool.execute).toHaveBeenCalledWith("call-1", { command: "git status" });
  });

  it("does not rewrite non-bash tools or when mode is off", async () => {
    const readTool = {
      name: "read",
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };
    const bashTool = {
      name: "bash",
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };

    const { wrapToolsWithRtkRewrite } = await import("../pi.js");
    const wrapped = wrapToolsWithRtkRewrite([readTool as any, bashTool as any], { mode: "off", timeoutMs: 100 });

    await (wrapped[0] as any).execute("call-read", { command: "cat package.json" });
    await (wrapped[1] as any).execute("call-bash", { command: "git status" });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(readTool.execute).toHaveBeenCalledWith("call-read", { command: "cat package.json" });
    expect(bashTool.execute).toHaveBeenCalledWith("call-bash", { command: "git status" });
  });

  it("passes the tool abort signal to the rtk subprocess", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "rtk git status\n", "");
    });
    const signal = new AbortController().signal;
    const bashTool = {
      name: "bash",
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };

    const { wrapToolsWithRtkRewrite } = await import("../pi.js");
    const wrapped = wrapToolsWithRtkRewrite([bashTool as any], { mode: "rewrite", timeoutMs: 100 });

    await (wrapped[0] as any).execute("call-1", { command: "git status" }, signal);

    expect(execFileMock).toHaveBeenCalledWith("rtk", ["rewrite", "git status"], expect.objectContaining({ signal }), expect.any(Function));
  });

  it("keeps action gating outside RTK rewriting so git policies see the original command", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: any) => {
      cb(null, "rtk git push\n", "");
    });
    const bashTool = {
      name: "bash",
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };

    const { wrapToolsWithActionGate, wrapToolsWithRtkRewrite } = await import("../pi.js");
    const rtkWrapped = wrapToolsWithRtkRewrite([bashTool as any], { mode: "rewrite", timeoutMs: 100 });
    const gated = wrapToolsWithActionGate(rtkWrapped, {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: {
        presetId: "custom",
        rules: {
          git_write: "block",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
        },
      },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn(),
    });

    const result = await (gated[0] as any).execute("call-1", { command: "git push" });

    expect((result as any).isError).toBe(true);
    expect((result as any).decision.category).toBe("git_write");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(bashTool.execute).not.toHaveBeenCalled();
  });
});

describe("worktree path boundary helpers", () => {
  // Test helper functions directly by importing them
  // Note: These tests verify the boundary logic without needing a full agent session
  beforeEach(() => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    realpathSyncNativeMock.mockImplementation((path: PathLike) => String(path));
  });

  describe("path boundary logic for worktree sessions", () => {
    it("wraps file tools with boundary validation when cwd is a worktree", async () => {
      const mockReadTool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "file content" }] }),
      };

      // Import the wrapping function
       
      const tools = [mockReadTool as any];

      // Simulate wrapping (normally done inside createFnAgent)
      const { wrapToolsWithBoundary } = await import("../pi.js");
      const wrapped = wrapToolsWithBoundary(
        tools,
        "/project/.worktrees/fn-001", // worktree path
        "/project", // project root
      );

      // Read inside worktree should work
      const insideResult = await (wrapped[0] as any).execute("call-1", { path: "/project/.worktrees/fn-001/src/file.ts" });
      expect(insideResult).toEqual({ ok: true, content: [{ type: "text", text: "file content" }] });
      expect(mockReadTool.execute).toHaveBeenCalled();

      // Reset mock
      mockReadTool.execute.mockClear();

      // Read outside worktree should be rejected
      const outsideResult = await (wrapped[0] as any).execute("call-2", { path: "/other/project/file.ts" });
      expect(outsideResult).toMatchObject({
        ok: false,
        error: expect.stringContaining("outside the worktree boundary"),
      });
      expect(mockReadTool.execute).not.toHaveBeenCalled();
    }, 15_000);

    it("allows macOS-canonicalized paths inside the worktree boundary", async () => {
      const mockBashTool = {
        name: "bash",
        label: "Bash",
        description: "Run a command",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [] }),
      };
      const worktreePath = "/var/folders/zp/fjh8794n7bl61c_pn1gmdt200000gn/T/fusion-ai-merge-fn-6085-2nTWPZ";
      const canonicalWorktreePath = "/private/var/folders/zp/fjh8794n7bl61c_pn1gmdt200000gn/T/fusion-ai-merge-fn-6085-2nTWPZ";
      realpathSyncNativeMock.mockImplementation((path: PathLike) => {
        const text = String(path);
        return text.startsWith("/var/folders/") ? `/private${text}` : text;
      });

      const { wrapToolsWithBoundary } = await import("../pi.js");
      const wrapped = wrapToolsWithBoundary(
        [mockBashTool as any],
        worktreePath,
        "/var/folders/zp/fjh8794n7bl61c_pn1gmdt200000gn/T/project",
      );

      const result = await (wrapped[0] as any).execute("call-1", {
        command: "pwd",
        cwd: canonicalWorktreePath,
      });

      expect(result).toEqual({ ok: true, content: [] });
      expect(mockBashTool.execute).toHaveBeenCalled();
    });

    it("allows project root .fusion/memory/ files from worktree session", async () => {
      const mockReadTool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "memory content" }] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");

      const wrapped = wrapToolsWithBoundary(
        [mockReadTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Reading project root .fusion/memory/ files should be allowed
      const result = await (wrapped[0] as any).execute("call-1", { path: "/project/.fusion/memory/MEMORY.md" });
      expect(mockReadTool.execute).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, content: [{ type: "text", text: "memory content" }] });

      // Reading project root .fusion/memory/MEMORY.md should also be allowed
      mockReadTool.execute.mockClear();
      const memoryResult = await (wrapped[0] as any).execute("call-2", { path: "/project/.fusion/memory/MEMORY.md" });
      expect(mockReadTool.execute).toHaveBeenCalled();
      expect(memoryResult).toEqual({ ok: true, content: [{ type: "text", text: "memory content" }] });

      // Reading project root .fusion/memory/2026-04-18.md should also be allowed
      mockReadTool.execute.mockClear();
      const dailyResult = await (wrapped[0] as any).execute("call-3", { path: "/project/.fusion/memory/2026-04-18.md" });
      expect(mockReadTool.execute).toHaveBeenCalled();
      expect(dailyResult).toEqual({ ok: true, content: [{ type: "text", text: "memory content" }] });

      // Reading project root .fusion/memory/DREAMS.md should also be allowed
      mockReadTool.execute.mockClear();
      const dreamsResult = await (wrapped[0] as any).execute("call-4", { path: "/project/.fusion/memory/DREAMS.md" });
      expect(mockReadTool.execute).toHaveBeenCalled();
      expect(dreamsResult).toEqual({ ok: true, content: [{ type: "text", text: "memory content" }] });
    });

    it("allows daily memory files under .fusion/memory from worktree session", async () => {
      const mockReadTool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "daily memory" }] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");

      const wrapped = wrapToolsWithBoundary(
        [mockReadTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      const result = await (wrapped[0] as any).execute("call-1", { path: "/project/.fusion/memory/2026-04-19.md" });
      expect(mockReadTool.execute).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, content: [{ type: "text", text: "daily memory" }] });
    });

    it("allows task attachments from worktree session", async () => {
      const mockReadTool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "attachment content" }] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");
       
      const wrapped = wrapToolsWithBoundary(
        [mockReadTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Reading task attachment should be allowed
      const result = await (wrapped[0] as any).execute("call-1", { path: "/project/.fusion/tasks/FN-001/attachments/screenshot.png" });
      expect(mockReadTool.execute).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, content: [{ type: "text", text: "attachment content" }] });
    });

    it("does not wrap tools when cwd is not a worktree", async () => {
      const mockTool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");
       
      const wrapped = wrapToolsWithBoundary([mockTool as any], null, null);

      // Should be the same tool, not wrapped
      expect(wrapped[0]).toBe(mockTool);

      // Any path should work
      await (wrapped[0] as any).execute("call-1", { path: "/any/path/file.ts" });
      expect(mockTool.execute).toHaveBeenCalled();
    });

    it("wraps only file tools, not other tools", async () => {
      const mockTaskTool = {
        name: "fn_task_create",
        label: "Create Task",
        description: "Create a task",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");
       
      const wrapped = wrapToolsWithBoundary(
        [mockTaskTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // fn_task_create should be unchanged (not wrapped)
      expect(wrapped[0]).toBe(mockTaskTool);
    });

    it("rejects write to paths outside worktree", async () => {
      const mockWriteTool = {
        name: "write",
        label: "Write",
        description: "Write a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");
       
      const wrapped = wrapToolsWithBoundary(
        [mockWriteTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Writing outside worktree should be rejected
      const result = await (wrapped[0] as any).execute("call-1", { path: "/another/project/file.ts" });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("outside the worktree boundary"),
      });
      expect(mockWriteTool.execute).not.toHaveBeenCalled();
    });

    it("rejects bash commands with cwd outside worktree", async () => {
      const mockBashTool = {
        name: "bash",
        label: "Bash",
        description: "Run a command",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");
       
      const wrapped = wrapToolsWithBoundary(
        [mockBashTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Bash with cwd outside worktree should be rejected
      const result = await (wrapped[0] as any).execute("call-1", { command: "ls -la", cwd: "/another/project" });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("outside the worktree boundary"),
      });
      expect(mockBashTool.execute).not.toHaveBeenCalled();
    });

    it("allows bash commands without cwd or with cwd inside worktree", async () => {
      const mockBashTool = {
        name: "bash",
        label: "Bash",
        description: "Run a command",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "ls result" }] }),
      };

      const { wrapToolsWithBoundary } = await import("../pi.js");
       
      const wrapped = wrapToolsWithBoundary(
        [mockBashTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Bash without cwd should work
      let result = await (wrapped[0] as any).execute("call-1", { command: "ls -la" });
      expect(mockBashTool.execute).toHaveBeenCalled();

      mockBashTool.execute.mockClear();

      // Bash with cwd inside worktree should work
      result = await (wrapped[0] as any).execute("call-2", { command: "ls -la", cwd: "/project/.worktrees/fn-001" });
      expect(mockBashTool.execute).toHaveBeenCalled();
    });
  });
});

describe("wrapToolsWithPermanentAgentGating", () => {
  it("blocks policy-blocked actions and skips underlying tool", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn() };
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      permissionPolicy: {
        presetId: "locked-down",
        rules: { file_write_delete: "block" },
      },
    });

    const result = await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    expect((result as any).isError).toBe(true);
    expect((result as any).details).toEqual(expect.objectContaining({
      disposition: "block",
      category: "file_write_delete",
      toolName: "write",
    }));
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("requires approval for unknown tools and skips underlying tool", async () => {
    const tool = { name: "plugin_custom", label: "Plugin", description: "", parameters: {}, execute: vi.fn() };
    const createApprovalRequest = vi.fn().mockResolvedValue({ id: "apr-1" });
    const findPendingApprovalRequest = vi.fn().mockResolvedValue(null);
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      requester: { actorId: "agent-1", actorType: "agent", actorName: "Perm" },
      taskId: "FN-1",
      permissionPolicy: {
        presetId: "unrestricted",
        rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
        },
      },
      createApprovalRequest,
      findPendingApprovalRequest,
    });

    const result = await (wrapped[0] as any).execute("t1", { value: 1 });
    expect((result as any).isError).toBe(true);
    expect((result as any).details).toEqual(expect.objectContaining({
      disposition: "require-approval",
      category: "none",
      toolName: "plugin_custom",
      requiresApproval: true,
      approvalRequestId: "apr-1",
    }));
    expect(findPendingApprovalRequest).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      category: "command_execution",
      toolName: "plugin_custom",
    }));
    expect(tool.execute).not.toHaveBeenCalled();
  });

  // FN-7609: the permanent-agent gate must pass its computed dedupe key
  // through to createApprovalRequest so the closure can persist it into
  // targetAction.context.approvalDedupeKey — without this, a stateless
  // heartbeat retrying the same gated command mints a brand-new blank
  // approval every tick instead of reusing the pending one.
  it("passes the computed approvalDedupeKey through to createApprovalRequest", async () => {
    const tool = { name: "bash", label: "Bash", description: "", parameters: {}, execute: vi.fn() };
    const createApprovalRequest = vi.fn().mockResolvedValue({ id: "apr-dedupe-1" });
    const findPendingApprovalRequest = vi.fn().mockResolvedValue(null);
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      requester: { actorId: "agent-1", actorType: "agent", actorName: "Perm" },
      taskId: "FN-1",
      permissionPolicy: {
        presetId: "approval-required",
        rules: {
          git_write: "require-approval",
          file_write_delete: "require-approval",
          command_execution: "require-approval",
          network_api: "require-approval",
          task_agent_mutation: "require-approval",
        },
      },
      createApprovalRequest,
      findPendingApprovalRequest,
    });

    await (wrapped[0] as any).execute("t1", { command: "pnpm test" });

    expect(findPendingApprovalRequest).toHaveBeenCalledWith("agent-1|FN-1|bash|command_execution");
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "bash",
      approvalDedupeKey: "agent-1|FN-1|bash|command_execution",
    }));
  });

  it("reuses a pending approval instead of creating a duplicate on a repeated gated tick", async () => {
    const tool = { name: "bash", label: "Bash", description: "", parameters: {}, execute: vi.fn() };
    const createApprovalRequest = vi.fn().mockResolvedValue({ id: "apr-dedupe-2" });
    // Simulate a real findPendingApprovalRequest backed by a store that
    // persists context.approvalDedupeKey (as executor.ts/agent-heartbeat.ts
    // now do): first tick finds nothing and creates a request; the store then
    // "remembers" it, so the second identical tick finds it and reuses it.
    let stored: { id: string; targetAction: { context: Record<string, unknown> } } | null = null;
    const findPendingApprovalRequest = vi.fn(async (dedupeKey: string) => {
      if (stored && stored.targetAction.context.approvalDedupeKey === dedupeKey) {
        return stored as any;
      }
      return null;
    });
    const gating = {
      requester: { actorId: "agent-1", actorType: "agent" as const, actorName: "Perm" },
      taskId: "FN-1",
      permissionPolicy: {
        presetId: "approval-required" as const,
        rules: {
          git_write: "require-approval" as const,
          file_write_delete: "require-approval" as const,
          command_execution: "require-approval" as const,
          network_api: "require-approval" as const,
          task_agent_mutation: "require-approval" as const,
        },
      },
      createApprovalRequest: vi.fn(async (input: { toolName: string; approvalDedupeKey?: string }) => {
        const created = await createApprovalRequest(input);
        stored = { id: created.id, targetAction: { context: { approvalDedupeKey: input.approvalDedupeKey } } };
        return created;
      }),
      findPendingApprovalRequest,
    };
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], gating as any);

    await (wrapped[0] as any).execute("t1", { command: "pnpm test" });
    await (wrapped[0] as any).execute("t2", { command: "pnpm test" });

    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(findPendingApprovalRequest).toHaveBeenCalledTimes(2);
  });

  it("requires approval for governed internal task-mutation fn_* tools", async () => {
    const tool = { name: "fn_task_create", label: "Task Create", description: "", parameters: {}, execute: vi.fn().mockResolvedValue({ ok: true }) };
    const createApprovalRequest = vi.fn().mockResolvedValue({ id: "apr-fn-1" });
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      requester: { actorId: "agent-1", actorType: "agent", actorName: "Perm" },
      taskId: "FN-1",
      permissionPolicy: {
        presetId: "approval-required",
        rules: {
          git_write: "require-approval",
          file_write_delete: "require-approval",
          command_execution: "require-approval",
          network_api: "require-approval",
          task_agent_mutation: "require-approval",
        },
      },
      createApprovalRequest,
      findPendingApprovalRequest: vi.fn().mockResolvedValue(null),
    });

    const result = await (wrapped[0] as any).execute("t1", { description: "create" });
    expect((result as any).isError).toBe(true);
    expect((result as any).details).toEqual(expect.objectContaining({
      approvalRequestId: "apr-fn-1",
      category: "task_agent_mutation",
      disposition: "require-approval",
      requiresApproval: true,
      toolName: "fn_task_create",
    }));
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      category: "task_agent_mutation",
      toolName: "fn_task_create",
    }));
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("keeps read-only tools allowed without approval-request creation", async () => {
    const tool = { name: "read", label: "Read", description: "", parameters: {}, execute: vi.fn().mockResolvedValue({ ok: true }) };
    const createApprovalRequest = vi.fn();
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      permissionPolicy: {
        presetId: "approval-required",
        rules: {
          git_write: "require-approval",
          file_write_delete: "require-approval",
          command_execution: "require-approval",
          network_api: "require-approval",
          task_agent_mutation: "require-approval",
        },
      },
      createApprovalRequest,
    });

    await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).not.toHaveBeenCalled();
  });

  it("does not create approval requests for policy-block outcomes", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn() };
    const createApprovalRequest = vi.fn();
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      permissionPolicy: {
        presetId: "locked-down",
        rules: { file_write_delete: "block" },
      },
      createApprovalRequest,
    });

    await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("lets boundary rejections fire before permanent-agent gating", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn() };
    const { wrapToolsWithPermanentAgentGating, wrapToolsWithBoundary } = await import("../pi.js");
    const gated = wrapToolsWithPermanentAgentGating([tool as any], {
      permissionPolicy: {
        presetId: "locked-down",
        rules: { file_write_delete: "block" },
      },
    });
    const wrapped = wrapToolsWithBoundary(gated as any, "/project/.worktrees/fn-001", "/project");

    const result = await (wrapped[0] as any).execute("t1", { path: "/project/README.md" });
    expect((result as any).isError).toBe(true);
    expect((result as any).error).toContain("outside the worktree boundary");
    expect((result as any).details).toBeUndefined();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("bypasses wrapping for fn_heartbeat_done under locked-down policy", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, terminal: true });
    const tool = { name: "fn_heartbeat_done", label: "Heartbeat Done", description: "", parameters: {}, execute };
    const createApprovalRequest = vi.fn();
    const findPendingApprovalRequest = vi.fn();
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      permissionPolicy: {
        presetId: "locked-down",
        rules: {
          git_write: "block",
          file_write_delete: "block",
          command_execution: "block",
          network_api: "block",
          task_agent_mutation: "block",
        },
      },
      createApprovalRequest,
      findPendingApprovalRequest,
    });

    expect(wrapped[0]).toBe(tool);
    await expect((wrapped[0] as any).execute("t1", {})).resolves.toEqual({ ok: true, terminal: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(findPendingApprovalRequest).not.toHaveBeenCalled();
  });

  it.each<[
    "locked-down" | "approval-required",
    Record<string, "block" | "require-approval">,
    "fn_send_message" | "fn_post_room_message",
    Record<string, string>
  ]>([
    ["locked-down", {
      git_write: "block",
      file_write_delete: "block",
      command_execution: "block",
      network_api: "block",
      task_agent_mutation: "block",
    }, "fn_send_message", { message: "ping" }],
    ["approval-required", {
      git_write: "require-approval",
      file_write_delete: "require-approval",
      command_execution: "require-approval",
      network_api: "require-approval",
      task_agent_mutation: "require-approval",
    }, "fn_send_message", { message: "ping" }],
    ["locked-down", {
      git_write: "block",
      file_write_delete: "block",
      command_execution: "block",
      network_api: "block",
      task_agent_mutation: "block",
    }, "fn_post_room_message", { roomId: "room-1", content: "pong" }],
    ["approval-required", {
      git_write: "require-approval",
      file_write_delete: "require-approval",
      command_execution: "require-approval",
      network_api: "require-approval",
      task_agent_mutation: "require-approval",
    }, "fn_post_room_message", { roomId: "room-1", content: "pong" }],
  ])("bypasses wrapping for %s under %s policy", async (presetId, rules, toolName, args) => {
    const result = { ok: true, messageId: "msg-1" };
    const execute = vi.fn().mockResolvedValue(result);
    const tool = { name: toolName, label: "Message Tool", description: "", parameters: {}, execute };
    const createApprovalRequest = vi.fn();
    const findPendingApprovalRequest = vi.fn();
    const { wrapToolsWithPermanentAgentGating } = await import("../pi.js");
    const wrapped = wrapToolsWithPermanentAgentGating([tool as any], {
      permissionPolicy: { presetId, rules },
      createApprovalRequest,
      findPendingApprovalRequest,
    });

    expect(wrapped[0]).toBe(tool);
    await expect((wrapped[0] as any).execute("t1", args)).resolves.toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("t1", args);
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(findPendingApprovalRequest).not.toHaveBeenCalled();
  });
});

describe("wrapToolsWithActionGate", () => {
  const lockedDownRules = {
    "git_write": "block",
    "file_write_delete": "block",
    "command_execution": "block",
    "network_api": "block",
    "task_agent_mutation": "block",
  } as const;

  const approvalRules = {
    "git_write": "require-approval",
    "file_write_delete": "require-approval",
    "command_execution": "require-approval",
    "network_api": "require-approval",
    "task_agent_mutation": "require-approval",
  } as const;

  it("blocks disallowed actions and skips underlying tool", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn() };
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId: "locked-down", rules: lockedDownRules },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn(),
    });

    const result = await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    expect((result as any).isError).toBe(true);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("applies the status-aware action gate to ephemeral and fallback task workers", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn().mockResolvedValue({ ok: true }) };
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "executor-MAIN-008",
      agentName: "Fallback task worker",
      isEphemeral: true,
      taskId: "MAIN-008",
      permissionPolicy: { presetId: "locked-down", rules: lockedDownRules },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn().mockResolvedValue(null),
    });

    const result = await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    expect(result.isError).toBe(true);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("governs newly exposed heartbeat network tools by policy instead of withholding them", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool = { name: "fn_research_run", label: "Run Research", description: "", parameters: {}, execute };
    const { wrapToolsWithActionGate } = await import("../pi.js");

    const unrestricted = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: {
        presetId: "unrestricted",
        rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
        },
      },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn(),
    });
    await expect((unrestricted[0] as any).execute("run-allow", { query: "q" })).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);

    const locked = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId: "locked-down", rules: lockedDownRules },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn(),
    });
    const blocked = await (locked[0] as any).execute("run-block", { query: "q" });
    expect((blocked as any).isError).toBe(true);
    expect((blocked as any).decision).toEqual(expect.objectContaining({
      category: "network_api",
      disposition: "block",
      toolName: "fn_research_run",
    }));
    expect(execute).toHaveBeenCalledTimes(1);

    const createApprovalRequest = vi.fn().mockResolvedValue({ id: "apr-research-1" });
    const approval = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId: "approval-required", rules: approvalRules },
      createApprovalRequest,
      findApprovalByDedupeKey: vi.fn().mockResolvedValue(null),
      pauseForApproval: vi.fn(),
    });
    const pending = await (approval[0] as any).execute("run-approval", { query: "q" });
    expect((pending as any).isError).toBe(true);
    expect((pending as any).decision).toEqual(expect.objectContaining({
      category: "network_api",
      disposition: "require-approval",
      toolName: "fn_research_run",
      metadata: expect.objectContaining({ approvalRequestId: "apr-research-1" }),
    }));
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("creates request once and pauses once while pending", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn() };
    const createApprovalRequest = vi.fn().mockResolvedValue({ id: "apr-1" });
    const pauseForApproval = vi.fn();
    const findApprovalByDedupeKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "apr-1", status: "pending" });
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId: "approval-required", rules: approvalRules },
      createApprovalRequest,
      findApprovalByDedupeKey,
      pauseForApproval,
    });

    const first = await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    const second = await (wrapped[0] as any).execute("t2", { path: "a.ts" });

    expect((first as any).decision.metadata.approvalRequestId).toBe("apr-1");
    expect((second as any).decision.metadata.approvalRequestId).toBe("apr-1");
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    // FN-7608 (9e5c02511): the gate pause (pauseForApproval) now runs for BOTH the
    // newly-created-request sub-case AND the reused-pending sub-case, so each gated
    // execute while the approval is pending pauses the session (see pi.ts FNXC:ActionGate).
    expect(pauseForApproval).toHaveBeenCalledTimes(2);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("executes once and marks completed for approved retry", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn().mockResolvedValue({ ok: true }) };
    const markApprovalCompleted = vi.fn();
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId: "approval-required", rules: approvalRules },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn().mockResolvedValue({ id: "apr-2", status: "approved" }),
      markApprovalCompleted,
    });

    await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(markApprovalCompleted).toHaveBeenCalledWith("apr-2");
  });

  it("does not mark completed when approved execution throws", async () => {
    const error = new Error("write failed");
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn().mockRejectedValue(error) };
    const markApprovalCompleted = vi.fn();
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId: "approval-required", rules: approvalRules },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn().mockResolvedValue({ id: "apr-2", status: "approved" }),
      markApprovalCompleted,
    });

    await expect((wrapped[0] as any).execute("t1", { path: "a.ts" })).rejects.toThrow("write failed");
    expect(markApprovalCompleted).not.toHaveBeenCalled();
  });

  it("returns rejection and never executes when latest decision is denied", async () => {
    const tool = { name: "write", label: "Write", description: "", parameters: {}, execute: vi.fn() };
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId: "approval-required", rules: approvalRules },
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn().mockResolvedValue({ id: "apr-3", status: "denied" }),
    });

    const result = await (wrapped[0] as any).execute("t1", { path: "a.ts" });
    expect((result as any).isError).toBe(true);
    expect((result as any).error).toContain("denied by approver");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it.each<[
    "locked-down" | "approval-required",
    typeof lockedDownRules | typeof approvalRules
  ]>([
    ["locked-down", lockedDownRules],
    ["approval-required", approvalRules],
  ])("bypasses wrapping for fn_heartbeat_done under %s policy", async (presetId, rules) => {
    const execute = vi.fn().mockResolvedValue({ ok: true, terminal: true });
    const tool = { name: "fn_heartbeat_done", label: "Heartbeat Done", description: "", parameters: {}, execute };
    const createApprovalRequest = vi.fn();
    const pauseForApproval = vi.fn();
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId, rules },
      createApprovalRequest,
      findApprovalByDedupeKey: vi.fn(),
      pauseForApproval,
    });

    expect(wrapped[0]).toBe(tool);
    await expect((wrapped[0] as any).execute("t1", {})).resolves.toEqual({ ok: true, terminal: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(pauseForApproval).not.toHaveBeenCalled();
  });

  it.each<[
    "locked-down" | "approval-required",
    typeof lockedDownRules | typeof approvalRules,
    "fn_send_message" | "fn_post_room_message",
    Record<string, string>
  ]>([
    ["locked-down", lockedDownRules, "fn_send_message", { message: "ping" }],
    ["approval-required", approvalRules, "fn_send_message", { message: "ping" }],
    ["locked-down", lockedDownRules, "fn_post_room_message", { roomId: "room-1", content: "pong" }],
    ["approval-required", approvalRules, "fn_post_room_message", { roomId: "room-1", content: "pong" }],
  ])("bypasses wrapping for %s under %s policy", async (presetId, rules, toolName, args) => {
    const result = { ok: true, messageId: "msg-2" };
    const execute = vi.fn().mockResolvedValue(result);
    const tool = { name: toolName, label: "Message Tool", description: "", parameters: {}, execute };
    const createApprovalRequest = vi.fn();
    const pauseForApproval = vi.fn();
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const wrapped = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: { presetId, rules },
      createApprovalRequest,
      findApprovalByDedupeKey: vi.fn(),
      pauseForApproval,
    });

    expect(wrapped[0]).toBe(tool);
    await expect((wrapped[0] as any).execute("t1", args)).resolves.toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("t1", args);
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(pauseForApproval).not.toHaveBeenCalled();
  });
});

describe("createFnAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSyncMock.mockReturnValue("");
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("{}");
    realpathSyncNativeMock.mockImplementation((path: PathLike) => String(path));
    readCustomProvidersMock.mockReturnValue([]);
    getAllMock.mockReturnValue([]);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));
    // #1675: re-establish default auth + session-id mock returns after clearAllMocks.
    authStorageGetApiKeyMock.mockImplementation(async (provider: string) => (
      provider === "anthropic" ? "sk-ant-api03-test-key" : undefined
    ));
    authStorageGetMock.mockImplementation((provider: string) => (
      provider === "anthropic" ? { type: "api_key", key: "sk-ant-api03-test-key" } : undefined
    ));
    authStorageHasMock.mockReturnValue(false);
    authStorageHasAuthMock.mockReturnValue(false);
    authStorageGetAllMock.mockReturnValue({});
    authStorageListMock.mockReturnValue([]);
    getApiKeyAndHeadersMock.mockResolvedValue({ ok: true, apiKey: undefined, headers: undefined });
    modelRuntimeGetAuthMock.mockImplementation(async () => ({ auth: { headers: {} as Record<string, string> } }));
    sessionManagerGetSessionIdMock.mockReturnValue(undefined);
    createBashToolMock.mockClear();
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        subscribe: vi.fn(),
        dispose: vi.fn(),
        setThinkingLevel: vi.fn(),
      },
    });
  });

  it("skips host extensions for merger sessions so dual-store fn_* tools cannot wedge merge", async () => {
    /*
    FNXC:MergeQueue 2026-07-15-11:08:
    FN-7956 hung AI merge review on extension fn_task_show (second TaskStore boot, no tool timeout).
    Merger sessions must not receive host @runfusion/fusion extension paths even with tools:coding.
    */
    const { createFnAgent, setHostExtensionPaths } = await import("../pi.js");
    setHostExtensionPaths(["/mock/fusion-extension"]);

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "merge",
      tools: "coding",
      sessionPurpose: "merger",
    });

    expect(resourceLoaderOptionsCapture).toHaveBeenCalled();
    const loaderOpts = resourceLoaderOptionsCapture.mock.calls.at(-1)?.[0] as {
      additionalExtensionPaths?: string[];
    };
    expect(loaderOpts.additionalExtensionPaths).toBeUndefined();

    setHostExtensionPaths([]);
  });

  it("still injects host extensions for coding non-merger sessions", async () => {
    const { createFnAgent, setHostExtensionPaths } = await import("../pi.js");
    setHostExtensionPaths(["/mock/fusion-extension"]);

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "execute",
      tools: "coding",
      sessionPurpose: "executor",
    });

    const loaderOpts = resourceLoaderOptionsCapture.mock.calls.at(-1)?.[0] as {
      additionalExtensionPaths?: string[];
    };
    expect(loaderOpts.additionalExtensionPaths).toEqual(["/mock/fusion-extension"]);

    setHostExtensionPaths([]);
  });

  it("passes task-scoped env into bash spawn hook when provided", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "test",
      tools: "coding",
      taskEnv: { PATH: "/task/bin", TASK_ONLY: "1" },
    });

    expect(createBashToolMock).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        spawnHook: expect.any(Function),
      }),
    );

    const spawnHook = createBashToolMock.mock.calls.at(-1)?.[1]?.spawnHook;
    const originalEnv = { PATH: "/base/bin", HOME: "/home/user" };
    const processEnvBefore = { ...process.env };
    const spawned = spawnHook({
      command: "echo hi",
      cwd: "/project",
      env: originalEnv,
    });

    expect(spawned).toEqual({
      command: "echo hi",
      cwd: "/project",
      env: {
        PATH: "/task/bin",
        HOME: "/home/user",
        TASK_ONLY: "1",
      },
    });
    expect(originalEnv).toEqual({ PATH: "/base/bin", HOME: "/home/user" });
    expect(process.env).toEqual(processEnvBefore);
  });

  it("keeps bash tool default behavior when taskEnv is not provided", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "test",
      tools: "coding",
    });

    expect(createBashToolMock).toHaveBeenCalledWith("/project", undefined);
  });

  it("keeps spawned env unchanged when taskEnv is empty", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "test",
      tools: "coding",
      taskEnv: {},
    });

    const spawnHook = createBashToolMock.mock.calls.at(-1)?.[1]?.spawnHook;
    const originalEnv = { HOME: "/home/user", PATH: "/bin" };
    const spawned = spawnHook({ command: "env", cwd: "/project", env: originalEnv });

    expect(spawned.env).toEqual({ HOME: "/home/user", PATH: "/bin" });
  });

  it("adds new task env keys absent from spawned env", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "test",
      tools: "coding",
      taskEnv: { TASK_ONLY: "abc" },
    });

    const spawnHook = createBashToolMock.mock.calls.at(-1)?.[1]?.spawnHook;
    const spawned = spawnHook({ command: "env", cwd: "/project", env: { HOME: "/home/user" } });

    expect(spawned.env).toEqual({ HOME: "/home/user", TASK_ONLY: "abc" });
  });

  it("preserves undefined task env values explicitly in merged env", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "test",
      tools: "coding",
      taskEnv: { TASK_OPTIONAL: undefined },
    });

    const spawnHook = createBashToolMock.mock.calls.at(-1)?.[1]?.spawnHook;
    const spawned = spawnHook({ command: "env", cwd: "/project", env: { HOME: "/home/user" } });

    expect(spawned.env).toEqual({ HOME: "/home/user", TASK_OPTIONAL: undefined });
  });

  it("injects PATH from task env when spawned env has no PATH", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project",
      systemPrompt: "test",
      tools: "coding",
      taskEnv: { PATH: "/task/bin" },
    });

    const spawnHook = createBashToolMock.mock.calls.at(-1)?.[1]?.spawnHook;
    const spawned = spawnHook({ command: "env", cwd: "/project", env: { HOME: "/home/user" } });

    expect(spawned.env).toEqual({ HOME: "/home/user", PATH: "/task/bin" });
  });

  it("refuses to start a coding agent in an unregistered worktree", async () => {
    existsSyncMock.mockImplementation((path) => {
      const value = String(path);
      return value === "/project/.worktrees/fn-001" ||
        value === "/project/.worktrees/fn-001/.git";
    });
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === "git rev-parse --show-toplevel") {
        return "/project/.worktrees/fn-001\n";
      }
      return "worktree /project\nHEAD abc123\nbranch refs/heads/main\n";
    });

    const { createFnAgent } = await import("../pi.js");

    await expect(createFnAgent({
      cwd: "/project/.worktrees/fn-001",
      systemPrompt: "test",
      tools: "coding",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    })).rejects.toThrow("Refusing to start coding agent in unregistered git worktree");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("allows a coding agent in a registered complete worktree without a root package.json", async () => {
    existsSyncMock.mockImplementation((path) => {
      const value = String(path);
      return value === "/project/.worktrees/fn-001" ||
        value === "/project/.worktrees/fn-001/.git";
    });
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === "git rev-parse --show-toplevel") {
        return "/project/.worktrees/fn-001\n";
      }
      return "worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n" +
        "worktree /project/.worktrees/fn-001\nHEAD def456\nbranch refs/heads/fusion/fn-001\n";
    });

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project/.worktrees/fn-001",
      systemPrompt: "test",
      tools: "coding",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("resolves project root from worktree cwd for convenience skills parameter", async () => {
    existsSyncMock.mockImplementation((path) => {
      const value = String(path);
      return value === "/project/.worktrees/task-branch" ||
        value === "/project/.worktrees/task-branch/.git";
    });
    execSyncMock.mockImplementation((cmd) => {
      if (cmd === "git rev-parse --show-toplevel") {
        return "/project/.worktrees/task-branch\n";
      }
      return "worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n" +
        "worktree /project/.worktrees/task-branch\nHEAD def456\nbranch refs/heads/fusion/fn-001\n";
    });

    const { createFnAgent } = await import("../pi.js");

    // Pass skills parameter with a worktree cwd.
    // getProjectRootFromWorktree extracts /project from the .worktrees path,
    // which is passed as projectRootDir to resolveSessionSkills.
    // resolveSessionSkills then calls resolveProjectRoot which walks up
    // looking for .fusion — since existsSync returns false for all paths
    // except the worktree itself, it falls back to /project.
    // The session should be created successfully.
    await createFnAgent({
      cwd: "/project/.worktrees/task-branch",
      systemPrompt: "test",
      tools: "coding",
      skills: ["fusion"],
    });

    // Verify the session was created (no crash)
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("FN-3338: registerExtensionProviders receives resolved project root when cwd is a subdirectory", async () => {
    // Simulate cwd being a subdirectory of the project. resolvePiExtensionProjectRoot
    // walks up from /project/src/components checking each dir for .fusion.
    existsSyncMock.mockImplementation((path) => {
      const value = String(path);
      return value === "/project/.fusion";
    });

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/project/src/components",
      systemPrompt: "test",
      tools: "readonly",
    });

    // registerExtensionProviders should receive the resolved project root,
    // not the raw subdirectory cwd. This is verified by checking the
    // DefaultPackageManager constructor received "/project" as cwd.
    expect(packageManagerCwdCapture).toHaveBeenCalledWith("/project");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("FN-3338: registerExtensionProviders falls back to cwd when no .fusion is found", async () => {
    // No .fusion directory exists anywhere above cwd.
    existsSyncMock.mockImplementation(() => false);

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/unrelated/directory",
      systemPrompt: "test",
      tools: "readonly",
    });

    // Falls back to the raw cwd when no .fusion is found
    expect(packageManagerCwdCapture).toHaveBeenCalledWith("/unrelated/directory");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("exposes project trust on the read-only pi settings view", async () => {
    const { createReadOnlyPiSettingsView } = await import("../pi.js");

    const view = createReadOnlyPiSettingsView("/tmp", "/mock-agent-dir");

    expect(() => view.isProjectTrusted()).not.toThrow();
    expect(view.isProjectTrusted()).toBe(true);
    expect(typeof view.isProjectTrusted()).toBe("boolean");
  });

  it("passes a project-trusted settings view through package-manager discovery", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
    });

    const settingsView = packageManagerSettingsCapture.mock.calls.at(-1)?.[0];
    expect(settingsView).toEqual(expect.objectContaining({ isProjectTrusted: expect.any(Function) }));
    expect(settingsView.isProjectTrusted()).toBe(true);
    expect(packageManagerResolveMock).toHaveBeenCalled();
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("registers extension providers before resolving configured models", async () => {
    packageManagerResolveMock.mockResolvedValueOnce({
      extensions: [{ enabled: true, path: "/extensions/zai-provider" }],
    });
    discoverAndLoadExtensionsMock.mockResolvedValueOnce({
      runtime: {
        pendingProviderRegistrations: [
          {
            name: "zai",
            config: { models: [{ id: "glm-5.1" }] },
            extensionPath: "/extensions/zai-provider",
          },
        ],
      },
      errors: [],
    });

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
    });

    expect(discoverAndLoadExtensionsMock).toHaveBeenCalledWith(
      ["/extensions/zai-provider"],
      "/tmp",
      "/tmp/.fusion/disabled-auto-extension-discovery",
    );
    expect(registerProviderMock).toHaveBeenNthCalledWith(1, "zai", expect.objectContaining({
      models: expect.arrayContaining([expect.objectContaining({ id: "glm-5.2" })]),
    }));
    // FN-7711: registerBuiltInGrokProvider seeds grok-cli immediately after the built-in zai
    // registration, before the extension's pending provider registrations replay.
    expect(registerProviderMock).toHaveBeenNthCalledWith(2, "grok-cli", expect.objectContaining({
      models: expect.arrayContaining([expect.objectContaining({ id: "grok-4.5" })]),
    }));
    expect(registerProviderMock).toHaveBeenNthCalledWith(3, "zai", expect.objectContaining({
      models: [{ id: "glm-5.1" }],
    }));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("registers custom providers from global settings", async () => {
    readCustomProvidersMock.mockReturnValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Custom OpenAI",
        apiType: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "CUSTOM_API_KEY",
        models: [{ id: "custom-model", name: "Custom Model" }],
      },
      {
        id: "660e8400-e29b-41d4-a716-446655440001",
        name: "Custom Responses",
        apiType: "openai-responses",
        baseUrl: "https://responses.example/v1",
        apiKey: "RESPONSES_API_KEY",
        models: [{ id: "responses-model", name: "Responses Model" }],
      },
      {
        id: "770e8400-e29b-41d4-a716-446655440002",
        name: "Custom Anthropic",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.example",
        apiKey: "ANTHROPIC_API_KEY",
        models: [{ id: "anthropic-model", name: "Anthropic Model" }],
      },
    ] as any);

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });

    expect(registerProviderMock).toHaveBeenCalledWith("custom-openai", expect.objectContaining({
      baseUrl: "https://custom.example/v1",
      api: "openai-completions",
      apiKey: "CUSTOM_API_KEY",
      models: [expect.objectContaining({ id: "custom-model", name: "Custom Model" })],
    }));
    expect(registerProviderMock).toHaveBeenCalledWith("custom-responses", expect.objectContaining({
      baseUrl: "https://responses.example/v1",
      api: "openai-responses",
      apiKey: "RESPONSES_API_KEY",
      models: [expect.objectContaining({ id: "responses-model", name: "Responses Model" })],
    }));
    /*
    FNXC:CustomProviders 2026-06-21-13:45:
    Invariant (FN-5893 surface = providers/execution paths): every custom-provider apiType must map to an api key pi-ai's registry actually registers. anthropic-compatible maps to "anthropic-messages", NOT bare "anthropic" — the latter registered fine but threw "No API provider registered for api: anthropic" the moment a task streamed. Assert the corrected value AND that the broken bare key is never used, so a future regression to "anthropic" fails here.
    */
    expect(registerProviderMock).toHaveBeenCalledWith("custom-anthropic", expect.objectContaining({
      baseUrl: "https://anthropic.example",
      api: "anthropic-messages",
      apiKey: "ANTHROPIC_API_KEY",
      models: [expect.objectContaining({ id: "anthropic-model", name: "Anthropic Model" })],
    }));
    // Negative guard: the unregistered bare "anthropic" api key must never be emitted for any provider.
    expect(registerProviderMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ api: "anthropic" }),
    );
    // Invariant: every api key handed to registerProvider must be one pi-ai registers
    // (mirrors @earendil-works/pi-ai register-builtins). Catches a typo in any arm.
    const PI_AI_REGISTERED_APIS = new Set([
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
      "google-generative-ai",
      "google-vertex",
      "mistral-conversations",
      "bedrock-converse-stream",
    ]);
    for (const [, config] of registerProviderMock.mock.calls) {
      const api = (config as { api?: string } | undefined)?.api;
      if (typeof api === "string") {
        expect(PI_AI_REGISTERED_APIS.has(api)).toBe(true);
      }
    }
  });

  /*
  FNXC:ProviderAuth 2026-07-08-00:00:
  FN-7689 regression coverage — registration path B (createFnAgent's inline custom-provider
  registration). Path A was already refactored into `buildCustomProviderModels` and reused here,
  but this test exists specifically to catch a future re-divergence: if someone inlines a fresh
  models.map(...) in createFnAgent again (as it was before this fix), this assertion fails.
  */
  it("registers openai-compatible custom providers with compat.cacheControlFormat='anthropic' when opted in (createFnAgent inline path)", async () => {
    readCustomProvidersMock.mockReturnValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Custom OpenAI Caching",
        apiType: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "CUSTOM_API_KEY",
        anthropicPromptCaching: true,
        models: [{ id: "custom-model", name: "Custom Model" }],
      },
      {
        id: "660e8400-e29b-41d4-a716-446655440001",
        name: "Custom OpenAI No Caching",
        apiType: "openai-compatible",
        baseUrl: "https://nocaching.example/v1",
        apiKey: "NOCACHE_API_KEY",
        models: [{ id: "nocache-model", name: "No Cache Model" }],
      },
      {
        id: "770e8400-e29b-41d4-a716-446655440002",
        name: "Custom Anthropic Caching Opt-in",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.example",
        apiKey: "ANTHROPIC_API_KEY",
        anthropicPromptCaching: true,
        models: [{ id: "anthropic-model", name: "Anthropic Model" }],
      },
    ] as any);

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });

    // Opted-in openai-compatible provider: cacheControlFormat must be set.
    expect(registerProviderMock).toHaveBeenCalledWith("custom-openai-caching", expect.objectContaining({
      api: "openai-completions",
      models: [expect.objectContaining({
        id: "custom-model",
        compat: expect.objectContaining({ cacheControlFormat: "anthropic" }),
      })],
    }));

    // Opted-out (default) openai-compatible provider: no forced cache_control marker.
    const noCacheCall = registerProviderMock.mock.calls.find(([key]: [string]) => key === "custom-openai-no-caching");
    expect(noCacheCall).toBeDefined();
    const [, noCacheConfig] = noCacheCall as [string, { models: Array<{ compat?: Record<string, unknown> }> }];
    expect(noCacheConfig.models[0].compat).not.toHaveProperty("cacheControlFormat");

    // anthropic-compatible provider: opt-in is a documented no-op — pi-ai's anthropic path already
    // auto-caches without this compat flag, and openai-completions-only compat must not leak in.
    const anthropicCall = registerProviderMock.mock.calls.find(([key]: [string]) => key === "custom-anthropic-caching-opt-in");
    expect(anthropicCall).toBeDefined();
    const [, anthropicConfig] = anthropicCall as [string, { api: string; models: Array<{ compat?: Record<string, unknown> }> }];
    expect(anthropicConfig.api).toBe("anthropic-messages");
    expect(anthropicConfig.models[0].compat).toBeUndefined();
  });

  it("avoids lock-based SettingsManager.create when loading extension providers", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });

    expect(packageManagerResolveMock).toHaveBeenCalled();
    expect(discoverAndLoadExtensionsMock).toHaveBeenCalled();
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(settingsManagerCreateMock).not.toHaveBeenCalled();
  });

  it("throws when the configured primary model cannot be resolved", async () => {
    findMock.mockImplementation((provider: string, modelId: string) => (
      provider === "zai" && modelId === "glm-5.1" ? undefined : { provider, id: modelId }
    ));

    const { createFnAgent } = await import("../pi.js");

    await expect(createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
    })).rejects.toThrow("Configured model zai/glm-5.1 (primary selection) was not found in the pi model registry");
    await expect(createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
    })).rejects.toThrow("Settings → Custom Providers");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("uses the configured fallback model when the primary model cannot be resolved", async () => {
    findMock.mockImplementation((provider: string, modelId: string) => {
      if (provider === "zai" && modelId === "glm-5.1") return undefined;
      return { provider, id: modelId };
    });

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.4",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });
  });

  it("throws when the configured fallback model cannot be resolved", async () => {
    findMock.mockImplementation((provider: string, modelId: string) => (
      provider === "openai-codex" && modelId === "missing-model" ? undefined : { provider, id: modelId }
    ));

    const { createFnAgent } = await import("../pi.js");

    await expect(createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackProvider: "openai-codex",
      fallbackModelId: "missing-model",
    })).rejects.toThrow("Configured model openai-codex/missing-model (fallback selection) was not found in the pi model registry");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  // FNXC:ModelRegistry 2026-07-09-00:00:
  // FN-7711 symptom verification: selecting grok-cli/grok-4.5 used to hard-fail at session
  // creation with "not found in the pi model registry" because the grok-cli provider was never
  // registered into the execution registry (see registerExtensionProviders in ../pi.js). This
  // mirrors the zai/glm-5.1 throw test above to reproduce the exact original failure, then proves
  // it is gone once the registry resolves a grok-cli model (mirroring how registerBuiltInGrokProvider
  // makes the provider resolvable), and that an unlisted grok-cli id also resolves via the
  // provider-base-model on-the-fly fallback.
  it("reproduces then proves gone the grok-cli/grok-4.5 'not found in the pi model registry' hard-fail", async () => {
    // Without any grok-cli provider registration, find() returns nothing and getAll() has no
    // grok-cli models — resolveConfiguredModel must throw the exact original error message.
    findMock.mockImplementation((provider: string, modelId: string) => (
      provider === "grok-cli" && modelId === "grok-4.5" ? undefined : { provider, id: modelId }
    ));
    getAllMock.mockReturnValue([]);

    const { createFnAgent } = await import("../pi.js");

    await expect(createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
    })).rejects.toThrow("Configured model grok-cli/grok-4.5 (primary selection) was not found in the pi model registry");
    expect(createAgentSessionMock).not.toHaveBeenCalled();

    // Once the grok-cli provider is resolvable (as it is after registerBuiltInGrokProvider seeds
    // it into the real execution registry via registerExtensionProviders), find() returns a model
    // and the session is created successfully — the hard-fail is gone.
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4.5",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "grok-cli", id: "grok-4.5" },
    });
  });

  it("resolves an unlisted grok-cli model id via the provider-base-model on-the-fly fallback", async () => {
    // find() has no entry for the unlisted id, but getAll() reports the provider has at least one
    // registered grok-cli model (as it does once registerBuiltInGrokProvider seeds the provider) —
    // resolveConfiguredModel should synthesize a model from the base model rather than throwing.
    findMock.mockImplementation((provider: string, modelId: string) => (
      provider === "grok-cli" && modelId === "grok-4-fast" ? undefined : { provider, id: modelId }
    ));
    getAllMock.mockReturnValue([{ provider: "grok-cli", id: "grok-4.5", name: "Grok 4.5" }]);

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "grok-cli",
      defaultModelId: "grok-4-fast",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "grok-cli", id: "grok-4-fast" },
    });
  });

  it("creates a session when configured models resolve successfully", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.3-codex",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0][0]).toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });
  });

  it("synthesizes direct Anthropic Claude Sonnet 5 from supplemental metadata when the live registry lacks it", async () => {
    // Live registry has no anthropic models; mergeSupplementalAnthropicModels re-adds Sonnet 5.
    getAllMock.mockReturnValue([]);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-5",
    });

    // SUPPLEMENTAL_ANTHROPIC_PROVIDER_REGISTRATION advertises claude-sonnet-5 on the direct provider again.
    expect(registerProviderMock).toHaveBeenCalledWith("anthropic", expect.objectContaining({
      models: expect.arrayContaining([expect.objectContaining({ id: "claude-sonnet-5" })]),
    }));
    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "anthropic", id: "claude-sonnet-5" },
    }));
  });

  it("does not duplicate Claude Sonnet 5 when the Anthropic registry already has it", async () => {
    getAllMock.mockReturnValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5 Upstream",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
    ]);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-5",
    });

    const anthropicRegistrations = registerProviderMock.mock.calls.filter(([name]) => name === "anthropic");
    expect(anthropicRegistrations).toHaveLength(0);
  });

  it("synthesizes OpenAI Codex GPT-5.6 models from supplemental metadata when the pi registry lacks them", async () => {
    // FNXC:ModelCatalog 2026-07-09-00:00:
    // FN-7754 regression coverage for the createFnAgent registry-seeding surface: a pi catalog with no openai-codex provider/models must still surface all GPT-5.6 codenamed variants through the shared additive supplemental merge.
    getAllMock.mockReturnValue([]);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.6-luna",
    });

    expect(registerProviderMock).toHaveBeenCalledWith("openai-codex", expect.objectContaining({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-luna" }),
        expect.objectContaining({ id: "gpt-5.6-sol" }),
        expect.objectContaining({ id: "gpt-5.6-terra" }),
      ]),
    }));
    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    }));
  });

  it("does not duplicate OpenAI Codex GPT-5.6 rows already present in the pi registry", async () => {
    const existingLunaRow = {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna Upstream",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2 },
      contextWindow: 200_000,
      maxTokens: 16_000,
    };
    getAllMock.mockReturnValue([existingLunaRow]);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.6-luna",
    });

    const openAiCodexRegistrations = registerProviderMock.mock.calls.filter(([name]) => name === "openai-codex");
    expect(openAiCodexRegistrations).toHaveLength(1);
    const registeredProvider = openAiCodexRegistrations[0]?.[1] as { models: Array<{ id: string; name?: string }> };
    const registeredModels = registeredProvider.models;
    const lunaRows = registeredModels.filter((model) => model.id === "gpt-5.6-luna");
    expect(lunaRows).toHaveLength(1);
    expect(lunaRows[0]).toMatchObject({ name: "GPT-5.6 Luna Upstream" });
    expect(registeredModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "gpt-5.6-sol" }),
      expect.objectContaining({ id: "gpt-5.6-terra" }),
    ]));
  });

  // Restored v0.51.0 behavior: a subscription-OAuth `anthropic/<model>` selection stays on
  // the built-in `anthropic` provider (pi-ai POSTs the OAuth token to /v1 with Claude Code
  // impersonation). No `/v1`-based `anthropic-subscription` provider is registered, and there
  // is no runtime reroute to `pi-claude-cli`.
  it("keeps subscription-OAuth Anthropic selections on the direct anthropic provider", async () => {
    authStorageGetMock.mockImplementation((provider: string) => provider === "anthropic-subscription"
      ? { type: "oauth", access: "subscription-access-token", refresh: "refresh", expires: Date.now() + 3_600_000 }
      : undefined);
    authStorageHasAuthMock.mockImplementation((provider: string) => provider === "anthropic-subscription");
    // Model selection no longer reads getApiKey (the reroute was removed); in production
    // getApiKey("anthropic") returns the OAuth token, resolved later at session execution.
    getAllMock.mockReturnValue([{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" }]);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-8",
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    }));
    expect(registerProviderMock).not.toHaveBeenCalledWith("anthropic-subscription", expect.anything());
    expect(createAgentSessionMock).not.toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ provider: "pi-claude-cli" }),
    }));
  });

  it("keeps explicit Claude CLI selections on the Claude CLI provider", async () => {
    authStorageGetApiKeyMock.mockResolvedValue(undefined);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "pi-claude-cli",
      defaultModelId: "claude-opus-4-8",
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "pi-claude-cli", id: "claude-opus-4-8" },
    }));
    expect(authStorageGetApiKeyMock).not.toHaveBeenCalledWith("pi-claude-cli");
  });

  it("keeps raw Anthropic API-key selections on the direct provider", async () => {
    authStorageGetApiKeyMock.mockImplementation(async (provider: string) => (
      provider === "anthropic" ? "sk-ant-api03-direct" : undefined
    ));

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-8",
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    }));
  });

  // Subscription OAuth must NOT depend on the Claude CLI provider being present — direct
  // OAuth to /v1 is its own surface. With pi-claude-cli unavailable it still runs on `anthropic`.
  it("does not require the Claude CLI provider for subscription-OAuth Anthropic execution", async () => {
    authStorageGetMock.mockImplementation((provider: string) => provider === "anthropic-subscription"
      ? { type: "oauth", access: "subscription-access-token", refresh: "refresh", expires: Date.now() + 3_600_000 }
      : undefined);
    authStorageHasAuthMock.mockImplementation((provider: string) => provider === "anthropic-subscription");
    // Model selection no longer reads getApiKey (the reroute was removed); production
    // resolves the OAuth token later, at session execution.
    findMock.mockImplementation((provider: string, modelId: string) => {
      if (provider === "pi-claude-cli") {
        return undefined;
      }
      return { provider, id: modelId };
    });
    getAllMock.mockReturnValue([{ provider: "anthropic", id: "claude-opus-4-8" }]);

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-4-8",
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    }));
  });

  it("backfills the resolved model onto sessions that do not mirror it", async () => {
    const session = {
      prompt: vi.fn(),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const { createFnAgent } = await import("../pi.js");
    const result = await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    }));
    expect(result.session).toBe(session);
    expect((result.session as { model?: unknown }).model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    });
  });

  it("keeps caller customTools in readonly sessions", async () => {
    createReadOnlyToolsMock.mockReturnValueOnce([{ name: "read" }] as any);
    const delegationTool = {
      name: "fn_list_agents",
      label: "List Agents",
      description: "List available agents",
      parameters: {},
      execute: vi.fn(),
    };

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      customTools: [delegationTool as any],
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string }> };
    expect(createSessionArgs.customTools.map((tool) => tool.name)).toContain("fn_list_agents");
  });

  it("does not allow extra builtin tools in readonly sessions by default", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { tools?: string[] };
    expect(createSessionArgs.tools).toBeUndefined();
  });

  it("intersects readonly builtin allowlist with readonly policy", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      builtinToolsAllowlist: ["WebSearch", "WebFetch"],
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { tools?: string[] };
    expect(createSessionArgs.tools).toEqual(expect.arrayContaining([
      "read",
      "grep",
      "find",
      "ls",
      "WebSearch",
      "WebFetch",
    ]));
  });

  it("filters coding tools with a case-insensitive toolsAllowlist", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
      toolsAllowlist: [" Read ", "GREP"],
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string }>; tools?: string[] };
    expect(createSessionArgs.customTools.map((tool) => tool.name).sort()).toEqual(["grep", "read"]);
    expect(createSessionArgs.tools).toEqual(["GREP", "Read", "grep", "read"]);
  });

  it("keeps all coding tools when toolsAllowlist is undefined", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string }>; tools?: string[] };
    expect(createSessionArgs.customTools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    expect(createSessionArgs.tools).toBeUndefined();
  });

  it("exposes no coding tools when toolsAllowlist is empty", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
      toolsAllowlist: [],
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string }>; tools?: string[] };
    expect(createSessionArgs.customTools).toEqual([]);
    expect(createSessionArgs.tools).toEqual([]);
  });

  it("keeps caller customTools in coding sessions", async () => {
    createCodingToolsMock.mockReturnValueOnce([{ name: "read" }, { name: "write" }] as any);
    const customTool = {
      name: "fn_heartbeat_done",
      label: "Heartbeat Done",
      description: "Complete heartbeat",
      parameters: {},
      execute: vi.fn(),
    };

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
      customTools: [customTool as any],
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string }> };
    expect(createSessionArgs.customTools.map((tool) => tool.name)).toContain("fn_heartbeat_done");
  });

  it("uses the status-aware action gate as the single approval authority when both gate contexts are present", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const permanentCreateApproval = vi.fn();
    const markApprovalCompleted = vi.fn();
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
      customTools: [{ name: "mcp__postiz__integrationlist", label: "List", description: "", parameters: {}, execute } as any],
      actionGateContext: {
        agentId: "executor-MAIN-008",
        agentName: "Fallback worker",
        isEphemeral: true,
        taskId: "MAIN-008",
        permissionPolicy: {
          presetId: "approval",
          rules: { git_write: "allow", file_write_delete: "allow", command_execution: "allow", network_api: "require-approval", task_agent_mutation: "allow" },
        },
        createApprovalRequest: vi.fn(),
        findApprovalByDedupeKey: vi.fn().mockResolvedValue({ id: "apr-main-008", status: "approved" }),
        markApprovalCompleted,
      },
      permanentAgentGating: {
        permissionPolicy: {
          presetId: "approval",
          rules: { git_write: "allow", file_write_delete: "allow", command_execution: "allow", network_api: "require-approval", task_agent_mutation: "allow" },
        },
        requester: { actorId: "executor-MAIN-008", actorType: "agent", actorName: "Fallback worker" },
        taskId: "MAIN-008",
        createApprovalRequest: permanentCreateApproval,
        findPendingApprovalRequest: vi.fn(),
      } as any,
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }> };
    const mcpTool = createSessionArgs.customTools.find((tool) => tool.name === "mcp__postiz__integrationlist")!;
    await expect(mcpTool.execute("call", {})).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(markApprovalCompleted).toHaveBeenCalledWith("apr-main-008");
    expect(permanentCreateApproval).not.toHaveBeenCalled();
  });

  it("exposes connected MCP tools in readonly sessions only with the explicit opt-in", async () => {
    const { createFnAgent } = await import("../pi.js");
    const close = vi.fn(async () => undefined);
    const mcpClient = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [{
          name: "lookup",
          description: "Lookup docs",
          inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
        }],
      })),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      close,
    };

    const created = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      mcpServers: [{ name: "docs", transport: "stdio", command: "node", enabled: true }],
      allowMcpToolsInReadonly: true,
      mcpClientFactory: () => mcpClient as any,
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string; parameters?: unknown }> };
    expect(createSessionArgs.customTools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "mcp__docs__lookup",
        parameters: expect.objectContaining({
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
        }),
      }),
    ]));

    await created.session.dispose?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["connect", "TypeError"],
    ["list", "RangeError"],
  ] as const)("fails configured MCP session bootstrap explicitly on %s failure and closes once", async (phase, reason) => {
    const close = vi.fn(async () => undefined);
    const mcpClient = {
      connect: vi.fn(async () => {
        if (phase === "connect") throw new TypeError("sensitive connection detail");
      }),
      listTools: vi.fn(async () => {
        if (phase === "list") throw new RangeError("sensitive listing detail");
        return { tools: [] };
      }),
      callTool: vi.fn(),
      close,
    };
    const { createFnAgent } = await import("../pi.js");

    await expect(createFnAgent({
      cwd: "/test/project",
      systemPrompt: "test",
      tools: "coding",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      mcpServers: [{ name: "postiz", transport: "stdio", command: "redacted", enabled: true }],
      mcpClientFactory: () => mcpClient as any,
    })).rejects.toThrow(`MCP session bootstrap failed: server=postiz reason=${reason}`);

    expect(close).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps MCP tools out of readonly sessions without the explicit opt-in", async () => {
    const { createFnAgent } = await import("../pi.js");
    const mcpClient = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [{ name: "lookup" }] })),
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
      close: vi.fn(async () => undefined),
    };

    await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      mcpServers: [{ name: "docs", transport: "stdio", command: "node", enabled: true }],
      mcpClientFactory: () => mcpClient as any,
    });

    const createSessionArgs = createAgentSessionMock.mock.calls[0]?.[0] as { customTools: Array<{ name: string }> };
    expect(mcpClient.connect).not.toHaveBeenCalled();
    expect(createSessionArgs.customTools.map((tool) => tool.name)).not.toContain("mcp__docs__lookup");
  });

  it("logs createFnAgent startup diagnostics without leaking cwd", async () => {
    const { piLog } = await import("../logger.js");
    const logSpy = vi.spyOn(piLog, "log").mockImplementation(() => {});
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/private-worktree",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });

    const startupLog = logSpy.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("createFnAgent called"));

    expect(startupLog).toBeDefined();
    expect(startupLog).toContain("createFnAgent called");
    expect(startupLog).toContain("tools=readonly");
    expect(startupLog).toContain("provider=openai-codex");
    expect(startupLog).toContain("model=gpt-5.4");
    expect(startupLog).not.toContain("cwd=");
    expect(startupLog).not.toContain("/tmp/private-worktree");

    logSpy.mockRestore();
  });

  it("falls back during prompt when the primary model has an auth failure", async () => {
    const primaryPrompt = vi.fn().mockRejectedValue(new Error("401 unauthorized: invalid api key"));
    const fallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const primaryDispose = vi.fn();

    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          prompt: primaryPrompt,
          subscribe: vi.fn(),
          dispose: primaryDispose,
          setThinkingLevel: vi.fn(),
        },
      })
      .mockResolvedValueOnce({
        session: {
          prompt: fallbackPrompt,
          subscribe: vi.fn(),
          dispose: vi.fn(),
          setThinkingLevel: vi.fn(),
        },
      });

    const { createFnAgent } = await import("../pi.js");

    const { session } = await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.3-codex",
    });

    await (session as any).promptWithFallback("make a spec");

    expect(primaryPrompt).toHaveBeenCalledWith("make a spec");
    expect(primaryDispose).toHaveBeenCalled();
    expect(fallbackPrompt).toHaveBeenCalledWith("make a spec");
    expect(createAgentSessionMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: { provider: "zai", id: "glm-5.1" },
    }));
    expect(createAgentSessionMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: { provider: "openai-codex", id: "gpt-5.3-codex" },
    }));
  });

  it("falls back during prompt when the primary model rejects temperature settings", async () => {
    const primaryPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid temperature: only 0.6 is allowed for this model"),
    );
    const fallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const primaryDispose = vi.fn();

    createAgentSessionMock
      .mockResolvedValueOnce({
        session: {
          prompt: primaryPrompt,
          subscribe: vi.fn(),
          dispose: primaryDispose,
          setThinkingLevel: vi.fn(),
        },
      })
      .mockResolvedValueOnce({
        session: {
          prompt: fallbackPrompt,
          subscribe: vi.fn(),
          dispose: vi.fn(),
          setThinkingLevel: vi.fn(),
        },
      });

    const { createFnAgent } = await import("../pi.js");

    const { session } = await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "kimi-coding",
      defaultModelId: "kimi-k2.6-preview",
      fallbackProvider: "zai",
      fallbackModelId: "glm-5.1",
    });

    await (session as any).promptWithFallback("review this spec");

    expect(primaryPrompt).toHaveBeenCalledWith("review this spec");
    expect(primaryDispose).toHaveBeenCalled();
    expect(fallbackPrompt).toHaveBeenCalledWith("review this spec");
    expect(createAgentSessionMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: { provider: "zai", id: "glm-5.1" },
    }));
  });

  it("enables auto-compaction to prevent context-window overflow", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "coding",
    });

    expect(settingsManagerInMemoryMock).toHaveBeenCalledTimes(1);
    expect(settingsManagerInMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        compaction: { enabled: true },
      }),
    );
  });

  it("passes compaction enabled alongside retry settings", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    expect(settingsManagerInMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 3 },
      }),
    );
  });

  it("preserves tool result content when extension hooks only modify metadata", async () => {
    const originalAfterToolCall = vi.fn().mockResolvedValue({ isError: false });
    const session = {
      agent: {
        afterToolCall: originalAfterToolCall,
      },
      prompt: vi.fn(),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const { createFnAgent } = await import("../pi.js");
    const { session: guardedSession } = await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
    });

    const result = await (guardedSession as any).agent.afterToolCall({
      toolCall: { id: "tool-1", name: "read" },
      args: { path: "file.txt" },
      result: { content: [{ type: "text", text: "ok" }], details: { source: "tool" } },
      isError: false,
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { source: "tool" },
      isError: false,
    });
  });

  it("repairs malformed persisted session messages missing content", async () => {
    const rewriteFile = vi.fn();
    const sessionManager = {
      fileEntries: [
        { type: "message", message: { role: "toolResult", toolName: "read" } },
        { type: "message", message: { role: "assistant", stopReason: "error" } },
      ],
      _rewriteFile: rewriteFile,
    };

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      sessionManager: sessionManager as any,
    });

    expect(sessionManager.fileEntries[0]?.message).toMatchObject({
      role: "toolResult",
      content: [],
    });
    expect(sessionManager.fileEntries[1]?.message).toMatchObject({
      role: "assistant",
      content: [],
    });
    expect(rewriteFile).toHaveBeenCalledTimes(1);
  });

  it("normalizes malformed live tool results before persistence and replay", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const stateMessages = [
      { role: "toolResult", toolCallId: "call-1", toolName: "read", timestamp: 123 },
    ];
    const originalAppendMessage = vi.fn();
    const sessionManager = {
      fileEntries: [],
      appendMessage: originalAppendMessage,
    };
    const session = {
      agent: {
        afterToolCall: vi.fn().mockResolvedValue(undefined),
        state: {
          messages: stateMessages,
        },
      },
      prompt: vi.fn(),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.push(listener);
        return vi.fn();
      }),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValueOnce({ session });

    const { createFnAgent } = await import("../pi.js");
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      sessionManager: sessionManager as any,
    });

    const liveMessage = stateMessages[0]!;
    listeners[0]?.({ type: "message_end", message: liveMessage });
    expect(liveMessage).toMatchObject({
      role: "toolResult",
      content: [],
    });

    const persistedMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      timestamp: 123,
    };
    sessionManager.appendMessage(persistedMessage as any);
    expect(originalAppendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "toolResult",
      content: [],
    }));
  });

  it("continues session creation when setting thinking level hits reasoning conflict", async () => {
    const { piLog } = await import("../logger.js");
    const warnSpy = vi.spyOn(piLog, "warn").mockImplementation(() => {});
    const setThinkingLevel = vi.fn(() => {
      throw new Error("400 cannot specify both 'thinking' and 'reasoning_effort'");
    });

    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        prompt: vi.fn(),
        subscribe: vi.fn(),
        dispose: vi.fn(),
        setThinkingLevel,
      },
    });

    const { createFnAgent } = await import("../pi.js");

    await expect(createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultThinkingLevel: "high",
    })).resolves.toBeTruthy();

    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Disabling explicit thinking level"));
    warnSpy.mockRestore();
  });

  // FNXC:SessionRouting 2026-06-24-11:30:
  // #1675: createFnAgent must resolve sessionRoutingId = taskId ?? piSessionId and
  // wrap the registry's getApiKeyAndHeaders so outbound requests carry routing
  // headers. These assert the wiring precedence end-to-end, not just the helper.
  /*
  FNXC:SessionRouting 2026-07-16-19:05:
  FN-8142 (pi 0.80.8+) moved the #1675 routing-header seam off ModelRegistry.getApiKeyAndHeaders
  onto ModelRuntime.getAuth (attachSessionRoutingHeaders). createAgentSession now receives the
  runtime via `modelRuntime`, so the wiring test captures that runtime and asserts the decorated
  getAuth merges X-Session-Id/X-Session-Affinity into the resolved auth headers. Precedence
  (taskId > pi session id > no wrap) is the invariant under test, unchanged by the migration.
  */
  describe("session routing headers wiring (#1675)", () => {
    const anyModel = { provider: "anthropic", id: "claude" } as never;

    async function createAndCaptureRuntime(overrides: Record<string, unknown> = {}) {
      const { createFnAgent } = await import("../pi.js");
      await createFnAgent({
        cwd: "/tmp",
        systemPrompt: "test",
        tools: "readonly",
        ...overrides,
      });
      const sessionOptions = createAgentSessionMock.mock.calls.at(-1)?.[0] as {
        modelRuntime: { getAuth: (model: unknown) => Promise<{ auth: { headers?: Record<string, string> } } | undefined> };
      };
      return sessionOptions.modelRuntime;
    }

    it("uses taskId as the routing id when provided", async () => {
      const runtime = await createAndCaptureRuntime({ taskId: "FN-7788" });

      const result = await runtime.getAuth(anyModel);

      expect(result?.auth.headers).toEqual({
        "X-Session-Id": "FN-7788",
        "X-Session-Affinity": "FN-7788",
      });
    });

    it("falls back to the pi session id when taskId is absent", async () => {
      sessionManagerGetSessionIdMock.mockReturnValue("pi-session-abc");
      const runtime = await createAndCaptureRuntime();

      const result = await runtime.getAuth(anyModel);

      expect(result?.auth.headers).toEqual({
        "X-Session-Id": "pi-session-abc",
        "X-Session-Affinity": "pi-session-abc",
      });
    });

    it("does not wrap getAuth when neither taskId nor a session id is available", async () => {
      // Base getAuth resolves { auth: { headers: {} } }; if the wrapper were
      // applied, headers would be populated with X-Session-*.
      const runtime = await createAndCaptureRuntime();

      const result = await runtime.getAuth(anyModel);

      expect(result?.auth.headers).toEqual({});
    });
  });

  describe("skill selection", () => {
    beforeEach(() => {
      // Reset modules to ensure fresh imports for each test
      vi.resetModules();
    });

    it("without skillSelection does not pass skillsOverride to resource loader", async () => {
      let capturedResourceLoaderOptions: any;
      vi.doMock("@earendil-works/pi-coding-agent", () => ({
        LegacyCredentialStorage: {
          create: () => ({
            setFallbackResolver: setFallbackResolverMock,
          }),
        },
        createAgentSession: createAgentSessionMock,
        createBashTool: () => ({ name: "bash" }),
        createCodingTools: createCodingToolsMock,
        createEditTool: () => ({ name: "edit" }),
        createExtensionRuntime: createExtensionRuntimeMock,
        createFindTool: () => ({ name: "find" }),
        createGrepTool: () => ({ name: "grep" }),
        createLsTool: () => ({ name: "ls" }),
        createReadOnlyTools: createReadOnlyToolsMock,
        createReadTool: () => ({ name: "read" }),
        createWriteTool: () => ({ name: "write" }),
        DefaultResourceLoader: class {
          constructor(options: any) {
            capturedResourceLoaderOptions = options;
          }
          async reload() {
            await reloadMock();
          }
        },
        DefaultPackageManager: class {
          constructor(options: any) {
            packageManagerCwdCapture(options?.cwd);
          }
          async resolve() {
            return packageManagerResolveMock();
          }
        },
        getAgentDir: () => "/mock-agent-dir",
        // FNXC:ModelRegistry 2026-07-16-19:05: FN-8142 async ModelRuntime; mock so registry path resolves (see main mock above).
        ModelRuntime: {
          create: async () => ({ getAuth: async () => undefined }),
        },
        ModelRegistry: class {
          static create(...args: unknown[]) {
            return new (this as unknown as new () => unknown)();
          }
          find(provider: string, modelId: string) {
            return findMock(provider, modelId);
          }
          getAll() {
            return getAllMock();
          }
          registerProvider(name: string, config: unknown) {
            return registerProviderMock(name, config);
          }
          refresh() {
            return refreshMock();
          }
        },
        SessionManager: {
          inMemory: () => ({ kind: "session-manager" }),
        },
        SettingsManager: {
          create: settingsManagerCreateMock,
          inMemory: settingsManagerInMemoryMock,
        },
      }));

      const { createFnAgent: freshCreateFnAgent } = await import("../pi.js");

      await freshCreateFnAgent({
        cwd: "/tmp",
        systemPrompt: "test",
        tools: "coding",
      });

      // skillsOverride should not be present when skillSelection is not provided
      expect(capturedResourceLoaderOptions.skillsOverride).toBeUndefined();
    });

    it("with skillSelection (empty patterns, no requested names) passes through all skills (filter not active)", async () => {
      // Mock existsSync to return true for settings file
      existsSyncMock.mockImplementation((path) => {
        const value = String(path);
        return value.includes(".fusion/settings.json");
      });
      readFileSyncMock.mockImplementation((path) => {
        const value = String(path);
        if (value.includes(".fusion/settings.json")) {
          return JSON.stringify({});
        }
        return "{}";
      });

      let capturedResourceLoaderOptions: any;
      vi.doMock("@earendil-works/pi-coding-agent", () => ({
        LegacyCredentialStorage: {
          create: () => ({
            setFallbackResolver: setFallbackResolverMock,
          }),
        },
        createAgentSession: createAgentSessionMock,
        createBashTool: () => ({ name: "bash" }),
        createCodingTools: createCodingToolsMock,
        createEditTool: () => ({ name: "edit" }),
        createExtensionRuntime: createExtensionRuntimeMock,
        createFindTool: () => ({ name: "find" }),
        createGrepTool: () => ({ name: "grep" }),
        createLsTool: () => ({ name: "ls" }),
        createReadOnlyTools: createReadOnlyToolsMock,
        createReadTool: () => ({ name: "read" }),
        createWriteTool: () => ({ name: "write" }),
        DefaultResourceLoader: class {
          constructor(options: any) {
            capturedResourceLoaderOptions = options;
          }
          async reload() {
            await reloadMock();
          }
        },
        DefaultPackageManager: class {
          constructor(options: any) {
            packageManagerCwdCapture(options?.cwd);
          }
          async resolve() {
            return packageManagerResolveMock();
          }
        },
        getAgentDir: () => "/mock-agent-dir",
        // FNXC:ModelRegistry 2026-07-16-19:05: FN-8142 async ModelRuntime; mock so registry path resolves (see main mock above).
        ModelRuntime: {
          create: async () => ({ getAuth: async () => undefined }),
        },
        ModelRegistry: class {
          static create(...args: unknown[]) {
            return new (this as unknown as new () => unknown)();
          }
          find(provider: string, modelId: string) {
            return findMock(provider, modelId);
          }
          getAll() {
            return getAllMock();
          }
          registerProvider(name: string, config: unknown) {
            return registerProviderMock(name, config);
          }
          refresh() {
            return refreshMock();
          }
        },
        SessionManager: {
          inMemory: () => ({ kind: "session-manager" }),
        },
        SettingsManager: {
          create: settingsManagerCreateMock,
          inMemory: settingsManagerInMemoryMock,
        },
      }));

      const { createFnAgent: freshCreateFnAgent } = await import("../pi.js");

      await freshCreateFnAgent({
        cwd: "/tmp",
        systemPrompt: "test",
        tools: "coding",
        skillSelection: {
          projectRootDir: "/tmp",
        },
      });

      // When filterActive is false, skillsOverride returns base unchanged
      // The callback should exist but simply return the base skills
      if (capturedResourceLoaderOptions.skillsOverride) {
        const result = capturedResourceLoaderOptions.skillsOverride({
          skills: [{ name: "test", filePath: "/path", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false }],
          diagnostics: [],
        });
        expect(result.skills).toHaveLength(1); // All skills pass through
      }
    });

    it("with skillSelection (specific requested names) activates skill filtering", async () => {
      let capturedResourceLoaderOptions: any;
      vi.doMock("@earendil-works/pi-coding-agent", () => ({
        LegacyCredentialStorage: {
          create: () => ({
            setFallbackResolver: setFallbackResolverMock,
          }),
        },
        createAgentSession: createAgentSessionMock,
        createBashTool: () => ({ name: "bash" }),
        createCodingTools: createCodingToolsMock,
        createEditTool: () => ({ name: "edit" }),
        createExtensionRuntime: createExtensionRuntimeMock,
        createFindTool: () => ({ name: "find" }),
        createGrepTool: () => ({ name: "grep" }),
        createLsTool: () => ({ name: "ls" }),
        createReadOnlyTools: createReadOnlyToolsMock,
        createReadTool: () => ({ name: "read" }),
        createWriteTool: () => ({ name: "write" }),
        DefaultResourceLoader: class {
          constructor(options: any) {
            capturedResourceLoaderOptions = options;
          }
          async reload() {
            await reloadMock();
          }
        },
        DefaultPackageManager: class {
          constructor(options: any) {
            packageManagerCwdCapture(options?.cwd);
          }
          async resolve() {
            return packageManagerResolveMock();
          }
        },
        getAgentDir: () => "/mock-agent-dir",
        // FNXC:ModelRegistry 2026-07-16-19:05: FN-8142 async ModelRuntime; mock so registry path resolves (see main mock above).
        ModelRuntime: {
          create: async () => ({ getAuth: async () => undefined }),
        },
        ModelRegistry: class {
          static create(...args: unknown[]) {
            return new (this as unknown as new () => unknown)();
          }
          find(provider: string, modelId: string) {
            return findMock(provider, modelId);
          }
          getAll() {
            return getAllMock();
          }
          registerProvider(name: string, config: unknown) {
            return registerProviderMock(name, config);
          }
          refresh() {
            return refreshMock();
          }
        },
        SessionManager: {
          inMemory: () => ({ kind: "session-manager" }),
        },
        SettingsManager: {
          create: settingsManagerCreateMock,
          inMemory: settingsManagerInMemoryMock,
        },
      }));

      const { createFnAgent: freshCreateFnAgent } = await import("../pi.js");

      await freshCreateFnAgent({
        cwd: "/tmp",
        systemPrompt: "test",
        tools: "coding",
        skillSelection: {
          projectRootDir: "/tmp",
          requestedSkillNames: ["paperclip"],
          sessionPurpose: "executor",
        },
      });

      // skillsOverride should be present
      expect(capturedResourceLoaderOptions.skillsOverride).toBeDefined();

      // The override should filter skills
      const result = capturedResourceLoaderOptions.skillsOverride({
        skills: [
          { name: "paperclip", filePath: "/path/paperclip", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "lint", filePath: "/path/lint", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      });

      // Only paperclip should pass through (matching requested name)
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("paperclip");
    });

    it("diagnostics are logged via structured logger with [skills] context", async () => {
      const { piLog } = await import("../logger.js");
      const piLogSpy = vi.spyOn(piLog, "log").mockImplementation(() => {});

      // Test diagnostics logging by directly calling createSkillsOverrideFromSelection
      const { createSkillsOverrideFromSelection } = await import("../skill-resolver.js");

      const selection = {
        allowedSkillPaths: new Set<string>(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["nonexistent"],
        sessionPurpose: "executor",
      });

      // Invoke the override to trigger diagnostics
      const result = override({
        skills: [],
        diagnostics: [],
      });

      // Check that diagnostics were produced
      expect(result.diagnostics.length).toBeGreaterThan(0);

      // Check that diagnostics were logged with [skills] context
      const skillLogs = piLogSpy.mock.calls.filter(call =>
        String(call[0]).includes("[skills]")
      );
      expect(skillLogs.length).toBeGreaterThan(0);

      // Should include the session purpose
      const lastLog = skillLogs[skillLogs.length - 1][0] as string;
      expect(lastLog).toContain("[executor]");

      piLogSpy.mockRestore();
    });
  });
});
