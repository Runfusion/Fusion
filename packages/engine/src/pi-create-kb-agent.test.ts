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
const execSyncMock = vi.fn(() => "");
const existsSyncMock = vi.fn((_path: PathLike) => false);
const readFileSyncMock = vi.fn(() => "{}");

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

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
  createCodingTools: createCodingToolsMock,
  createExtensionRuntime: createExtensionRuntimeMock,
  createReadOnlyTools: createReadOnlyToolsMock,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools = [mockReadTool as any];

      // Simulate wrapping (normally done inside createKbAgent)
      const { wrapToolsWithBoundary } = await import("./pi.js");
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
      expect(outsideResult).toEqual({
        ok: false,
        error: expect.stringContaining("outside the worktree boundary"),
      });
      expect(mockReadTool.execute).not.toHaveBeenCalled();
    });

    it("allows project root .fusion/memory.md from worktree session", async () => {
      const mockReadTool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "memory content" }] }),
      };

      const { wrapToolsWithBoundary } = await import("./pi.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = wrapToolsWithBoundary(
        [mockReadTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Reading project root .fusion/memory.md should be allowed
      const result = await (wrapped[0] as any).execute("call-1", { path: "/project/.fusion/memory.md" });
      expect(mockReadTool.execute).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, content: [{ type: "text", text: "memory content" }] });
    });

    it("allows task attachments from worktree session", async () => {
      const mockReadTool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: "attachment content" }] }),
      };

      const { wrapToolsWithBoundary } = await import("./pi.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      const { wrapToolsWithBoundary } = await import("./pi.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = wrapToolsWithBoundary([mockTool as any], null, null);

      // Should be the same tool, not wrapped
      expect(wrapped[0]).toBe(mockTool);

      // Any path should work
      await (wrapped[0] as any).execute("call-1", { path: "/any/path/file.ts" });
      expect(mockTool.execute).toHaveBeenCalled();
    });

    it("wraps only file tools, not other tools", async () => {
      const mockTaskTool = {
        name: "task_create",
        label: "Create Task",
        description: "Create a task",
        parameters: {},
        execute: vi.fn().mockResolvedValue({ ok: true, content: [] }),
      };

      const { wrapToolsWithBoundary } = await import("./pi.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = wrapToolsWithBoundary(
        [mockTaskTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // task_create should be unchanged (not wrapped)
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

      const { wrapToolsWithBoundary } = await import("./pi.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = wrapToolsWithBoundary(
        [mockWriteTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Writing outside worktree should be rejected
      const result = await (wrapped[0] as any).execute("call-1", { path: "/another/project/file.ts" });
      expect(result).toEqual({
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

      const { wrapToolsWithBoundary } = await import("./pi.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = wrapToolsWithBoundary(
        [mockBashTool as any],
        "/project/.worktrees/fn-001",
        "/project",
      );

      // Bash with cwd outside worktree should be rejected
      const result = await (wrapped[0] as any).execute("call-1", { command: "ls -la", cwd: "/another/project" });
      expect(result).toEqual({
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

      const { wrapToolsWithBoundary } = await import("./pi.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

describe("createKbAgent", () => {
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
        value === "/project/.worktrees/fn-001/.git" ||
        value === "/project/.worktrees/fn-001/package.json";
    });
    execSyncMock.mockReturnValue("worktree /project\nHEAD abc123\nbranch refs/heads/main\n");

    const { createKbAgent } = await import("./pi.js");

    await expect(createKbAgent({
      cwd: "/project/.worktrees/fn-001",
      systemPrompt: "test",
      tools: "coding",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    })).rejects.toThrow("Refusing to start coding agent in unregistered git worktree");

    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("allows a coding agent in a registered complete worktree", async () => {
    existsSyncMock.mockImplementation((path) => {
      const value = String(path);
      return value === "/project/.worktrees/fn-001" ||
        value === "/project/.worktrees/fn-001/.git" ||
        value === "/project/.worktrees/fn-001/package.json";
    });
    execSyncMock.mockReturnValue(
      "worktree /project\nHEAD abc123\nbranch refs/heads/main\n\n" +
      "worktree /project/.worktrees/fn-001\nHEAD def456\nbranch refs/heads/fusion/fn-001\n",
    );

    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
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

    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "zai",
      defaultModelId: "glm-5.1",
    });

    expect(discoverAndLoadExtensionsMock).toHaveBeenCalledWith(["/extensions/zai-provider"], "/tmp", undefined);
    expect(registerProviderMock).toHaveBeenCalledWith("zai", expect.objectContaining({
      models: [{ id: "glm-5.1" }],
    }));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("avoids lock-based SettingsManager.create when loading extension providers", async () => {
    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
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

    const { createKbAgent } = await import("./pi.js");

    await expect(createKbAgent({
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

    const { createKbAgent } = await import("./pi.js");

    await expect(createKbAgent({
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
    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
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

  it("enables auto-compaction to prevent context-window overflow", async () => {
    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
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
    const { createKbAgent } = await import("./pi.js");

    await createKbAgent({
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
});
