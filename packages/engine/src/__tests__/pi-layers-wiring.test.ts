import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PathLike } from "node:fs";

/**
 * Tests that createFnAgent correctly wires prompt layers to
 * DefaultResourceLoader and that tools are sorted deterministically.
 *
 * These tests verify the actual subsystem wiring rather than testing
 * the layer logic in isolation.
 */

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
const settingsManagerInMemoryMock = vi.fn(() => ({ kind: "settings-manager" }));
const setFallbackResolverMock = vi.fn();
const reloadMock = vi.fn(async () => {});
const execSyncMock = vi.fn((_cmd?: any, _opts?: any) => "");
const existsSyncMock = vi.fn((_path: PathLike) => false);
const readFileSyncMock = vi.fn((_path?: any) => "{}");
const readCustomProvidersMock = vi.fn(() => []);

// Capture DefaultResourceLoader constructor args
let capturedResourceLoaderOptions: any = null;

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

vi.mock("../custom-providers.js", () => ({
  readCustomProviders: readCustomProvidersMock,
}));

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
    static create(..._args: unknown[]) {
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
    create: vi.fn(),
    inMemory: settingsManagerInMemoryMock,
  },
}));

describe("createFnAgent prompt layer wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedResourceLoaderOptions = null;
    execSyncMock.mockReturnValue("");
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("{}");
    readCustomProvidersMock.mockReturnValue([]);
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

  it("passes stable layer as systemPromptOverride when layers provided", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Stable prefix.\n\nDynamic suffix.",
      systemPromptLayers: {
        stable: "Stable prefix.",
        dynamic: "Dynamic suffix.",
      },
    });

    expect(capturedResourceLoaderOptions).toBeDefined();
    const override = capturedResourceLoaderOptions.systemPromptOverride();
    expect(override).toBe("Stable prefix.");
  });

  it("passes dynamic layer via appendSystemPromptOverride when layers provided", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Stable.\n\nDynamic content.",
      systemPromptLayers: {
        stable: "Stable.",
        dynamic: "Dynamic content.",
      },
    });

    expect(capturedResourceLoaderOptions).toBeDefined();
    const appended = capturedResourceLoaderOptions.appendSystemPromptOverride();
    expect(appended).toEqual(["Dynamic content."]);
  });

  it("falls back to full systemPrompt when no layers provided", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Full system prompt.",
    });

    expect(capturedResourceLoaderOptions).toBeDefined();
    const override = capturedResourceLoaderOptions.systemPromptOverride();
    expect(override).toBe("Full system prompt.");
  });

  it("returns empty array from appendSystemPromptOverride when no layers", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Full prompt.",
    });

    const appended = capturedResourceLoaderOptions.appendSystemPromptOverride();
    expect(appended).toEqual([]);
  });

  it("returns empty array from appendSystemPromptOverride when dynamic is empty", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Stable only.",
      systemPromptLayers: {
        stable: "Stable only.",
        dynamic: "",
      },
    });

    const appended = capturedResourceLoaderOptions.appendSystemPromptOverride();
    expect(appended).toEqual([]);
  });
});

describe("createFnAgent deterministic tool ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedResourceLoaderOptions = null;
    execSyncMock.mockReturnValue("");
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("{}");
    readCustomProvidersMock.mockReturnValue([]);
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

  it("passes tools to createAgentSession in alphabetical order", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Test.",
      tools: "coding",
    });

    expect(createAgentSessionMock).toHaveBeenCalled();

    const callArgs = createAgentSessionMock.mock.calls[0][0];
    const toolNames = (callArgs.customTools ?? []).map((t: any) => t.name);

    // Tools should be in alphabetical order
    const sorted = [...toolNames].sort();
    expect(toolNames).toEqual(sorted);
  });

  it("sorts custom tools mixed with built-in tools", async () => {
    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Test.",
      tools: "coding",
      customTools: [
        { name: "zzz_custom", execute: vi.fn() } as any,
        { name: "aaa_custom", execute: vi.fn() } as any,
      ],
    });

    const callArgs = createAgentSessionMock.mock.calls[0][0];
    const toolNames = (callArgs.customTools ?? []).map((t: any) => t.name);

    const sorted = [...toolNames].sort();
    expect(toolNames).toEqual(sorted);
  });

  it("sorts readonly tools with custom tools", async () => {
    createReadOnlyToolsMock.mockReturnValueOnce([
      { name: "read" },
      { name: "grep" },
      { name: "find" },
    ] as any);

    const { createFnAgent } = await import("../pi.js");

    await createFnAgent({
      cwd: "/tmp/test-project",
      systemPrompt: "Test.",
      tools: "readonly",
      customTools: [
        { name: "fn_task_list", execute: vi.fn() } as any,
      ],
    });

    const callArgs = createAgentSessionMock.mock.calls[0][0];
    const toolNames = (callArgs.customTools ?? []).map((t: any) => t.name);

    const sorted = [...toolNames].sort();
    expect(toolNames).toEqual(sorted);
  });
});
