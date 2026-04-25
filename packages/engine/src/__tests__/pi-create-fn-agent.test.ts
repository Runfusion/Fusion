import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PathLike } from "node:fs";

const createAgentSessionMock = vi.fn();
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
const settingsManagerCreateMock = vi.fn(() => ({ kind: "settings-manager-create" }));
const settingsManagerInMemoryMock = vi.fn(() => ({ kind: "settings-manager" }));
const setFallbackResolverMock = vi.fn();
const reloadMock = vi.fn(async () => {});
const execSyncMock = vi.fn((_cmd?: any, _opts?: any) => "");
const existsSyncMock = vi.fn((_path: PathLike) => false);
const readFileSyncMock = vi.fn((_path?: any) => "{}");

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
  return { execSync: execSyncFn, exec: execFn };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
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
    async reload() {
      await reloadMock();
    }
  },
  DefaultPackageManager: class {
    async resolve() {
      return packageManagerResolveMock();
    }
  },
  discoverAndLoadExtensions: discoverAndLoadExtensionsMock,
  getAgentDir: () => "/mock-agent-dir",
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

describe("worktree path boundary helpers", () => {
  // Test helper functions directly by importing them
  // Note: These tests verify the boundary logic without needing a full agent session

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

describe("createFnAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSyncMock.mockReturnValue("");
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("{}");
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));
    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt: vi.fn(),
        subscribe: vi.fn(),
        dispose: vi.fn(),
        setThinkingLevel: vi.fn(),
      },
    });
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
    expect(registerProviderMock).toHaveBeenCalledWith("zai", expect.objectContaining({
      models: [{ id: "glm-5.1" }],
    }));
    expect(refreshMock).toHaveBeenCalled();
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
    })).rejects.toThrow("Configured primary model zai/glm-5.1 was not found");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
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
    })).rejects.toThrow("Configured fallback model openai-codex/missing-model was not found");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
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

  describe("skill selection", () => {
    beforeEach(() => {
      // Reset modules to ensure fresh imports for each test
      vi.resetModules();
    });

    it("without skillSelection does not pass skillsOverride to resource loader", async () => {
      let capturedResourceLoaderOptions: any;
      vi.doMock("@mariozechner/pi-coding-agent", () => ({
        AuthStorage: {
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
          async resolve() {
            return packageManagerResolveMock();
          }
        },
        discoverAndLoadExtensions: discoverAndLoadExtensionsMock,
        getAgentDir: () => "/mock-agent-dir",
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
      vi.doMock("@mariozechner/pi-coding-agent", () => ({
        AuthStorage: {
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
          async resolve() {
            return packageManagerResolveMock();
          }
        },
        discoverAndLoadExtensions: discoverAndLoadExtensionsMock,
        getAgentDir: () => "/mock-agent-dir",
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
      vi.doMock("@mariozechner/pi-coding-agent", () => ({
        AuthStorage: {
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
          async resolve() {
            return packageManagerResolveMock();
          }
        },
        discoverAndLoadExtensions: discoverAndLoadExtensionsMock,
        getAgentDir: () => "/mock-agent-dir",
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
      const piWarnSpy = vi.spyOn(piLog, "warn").mockImplementation(() => {});

      // Test diagnostics logging by directly calling createSkillsOverrideFromSelection
      const { createSkillsOverrideFromSelection } = await import("../skill-resolver.js");

      const selection = {
        allowedSkillPaths: new Set(["/path/nonexistent"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
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
      const skillLogs = piWarnSpy.mock.calls.filter(call =>
        String(call[0]).includes("[skills]")
      );
      expect(skillLogs.length).toBeGreaterThan(0);

      // Should include the session purpose
      const lastLog = skillLogs[skillLogs.length - 1][0] as string;
      expect(lastLog).toContain("[executor]");

      piWarnSpy.mockRestore();
    });
  });
});
