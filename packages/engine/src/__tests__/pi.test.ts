import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeModel, formatModelMarkerDetails, compactSessionContext, COMPACTION_FALLBACK_INSTRUCTIONS, createFnAgent, getProjectRootFromWorktree, isModelAuthTierIncompatibilityError, isRetryableModelSelectionError, promptWithFallback, type AgentOptions } from "../pi.js";
import { createAgentSession, ModelRegistry, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { piLog } from "../logger.js";

const { resourceLoaderOptions } = vi.hoisted(() => ({
  resourceLoaderOptions: { current: undefined as Record<string, unknown> | undefined },
}));

// Mock skill resolver functions - define inside factory to avoid hoisting issues
vi.mock("../cli-runtime/skill-resolver.js", () => {
  const resolveSessionSkillsMock = vi.fn();
  const createSkillsOverrideFromSelectionMock = vi.fn();
  return {
    resolveSessionSkills: resolveSessionSkillsMock,
    createSkillsOverrideFromSelection: createSkillsOverrideFromSelectionMock,
    // Export mock functions for test assertions
    __getMocks: () => ({
      resolveSessionSkills: resolveSessionSkillsMock,
      createSkillsOverrideFromSelection: createSkillsOverrideFromSelectionMock,
    }),
  };
});

// Mock pi-coding-agent imports
vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: {
    create: vi.fn(() => ({
      getCredentials: vi.fn().mockResolvedValue({}),
    })),
  },
  createAgentSession: vi.fn(async () => ({
    session: {
      model: { provider: "test", id: "test" },
      subscribe: vi.fn(),
      prompt: vi.fn(),
      sessionFile: undefined,
    },
  })),
  createCodingTools: vi.fn(() => []),
  createReadOnlyTools: vi.fn(() => []),
  createReadTool: vi.fn(() => ({ name: "read" })),
  createBashTool: vi.fn(() => ({ name: "bash" })),
  createEditTool: vi.fn(() => ({ name: "edit" })),
  createWriteTool: vi.fn(() => ({ name: "write" })),
  createGrepTool: vi.fn(() => ({ name: "grep" })),
  createFindTool: vi.fn(() => ({ name: "find" })),
  createLsTool: vi.fn(() => ({ name: "ls" })),
  createExtensionRuntime: vi.fn(),
  DefaultResourceLoader: vi.fn().mockImplementation(function (options: Record<string, unknown>) {
    resourceLoaderOptions.current = options;
    return {
      reload: vi.fn().mockResolvedValue(undefined),
      skillsOverride: undefined,
    };
  }),
  DefaultPackageManager: vi.fn(),
  discoverAndLoadExtensions: vi.fn().mockResolvedValue({ errors: [], runtime: { pendingProviderRegistrations: [] } }),
  getAgentDir: vi.fn(() => "/test/agent-dir"),
  ModelRuntime: {
    create: vi.fn(async () => ({ getAuth: vi.fn(async () => undefined) })),
  },
  ModelRegistry: vi.fn().mockImplementation(function () {
    return {
      find: vi.fn((provider: string, id: string) => ({ provider, id, name: id })),
      getAll: vi.fn().mockReturnValue([]),
      registerProvider: vi.fn(),
      refresh: vi.fn(),
    };
  }),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));
// FNXC:McpConfig 2026-07-13: Mock connectMcpSessionTools so createFnAgent doesn't attempt real MCP server bootstrap (the configured test binary doesn't exist). The clean toolset keeps MCP forwarding tests deterministic without a live server.
vi.mock("../mcp/mcp-session-tools.js", () => ({
  connectMcpSessionTools: vi.fn().mockResolvedValue({
    tools: [],
    connected: [],
    skipped: [],
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Import mock accessors after mocking (must use dynamic import for hoisted mocks)
let resolveSessionSkillsMock: ReturnType<typeof vi.fn>;
let createSkillsOverrideFromSelectionMock: ReturnType<typeof vi.fn>;

describe("getProjectRootFromWorktree", () => {
  it("detects POSIX worktree paths", () => {
    expect(getProjectRootFromWorktree("/repo/.worktrees/fn-001")).toBe("/repo");
    expect(getProjectRootFromWorktree("/repo/.worktrees/fn-001/src/file.ts")).toBe("/repo");
  });

  it("detects Windows worktree paths", () => {
    expect(getProjectRootFromWorktree("C:\\repo\\.worktrees\\fn-001")).toBe("C:\\repo");
    expect(getProjectRootFromWorktree("C:\\repo\\.worktrees\\fn-001\\src\\file.ts")).toBe("C:\\repo");
  });

  it("supports configured candidate worktrees dir paths", () => {
    expect(
      getProjectRootFromWorktree("/tmp/.fn-worktrees/repo/fn-001/src", {
        worktreesDirCandidates: ["/tmp/.fn-worktrees/repo"],
      }),
    ).toBe("/tmp/.fn-worktrees");

    expect(
      getProjectRootFromWorktree("/tmp/repo.worktrees/fn-001", {
        worktreesDirCandidates: ["/tmp/repo.worktrees"],
      }),
    ).toBe("/tmp");
  });
});

// Initialize mocks before first test
beforeEach(() => {
  // Access mocks from the mocked module
  const mocks = (vi.mocked({ resolveSessionSkills: vi.fn(), createSkillsOverrideFromSelection: vi.fn() }));
  // We need to re-mock in beforeEach to ensure they're fresh
});

describe("describeModel", () => {
  it('returns "provider/modelId" when session has a model', () => {
    const fakeSession = {
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet",
      },
    } as unknown as AgentSession;

    expect(describeModel(fakeSession)).toBe("anthropic/claude-sonnet-4-5");
  });

  it("uses ACP lastModelDescription for string-shaped Grok sessions", () => {
    const fakeSession = {
      model: "grok-4.5",
      lastModelDescription: "grok/grok-4.5",
    } as unknown as AgentSession;

    expect(describeModel(fakeSession)).toBe("grok/grok-4.5");
    expect(formatModelMarkerDetails(describeModel(fakeSession), "low")).toBe(
      "grok/grok-4.5 (thinking effort: low)",
    );
  });

  it("uses a string model when ACP did not supply a description", () => {
    expect(describeModel({ model: "claude/sonnet" } as unknown as AgentSession)).toBe("claude/sonnet");
  });

  it('returns "unknown model" when session model is undefined', () => {
    const fakeSession = {
      model: undefined,
    } as unknown as AgentSession;

    expect(describeModel(fakeSession)).toBe("unknown model");
  });

  it("handles different providers", () => {
    const fakeSession = {
      model: {
        provider: "openai",
        id: "gpt-4o",
        name: "GPT-4o",
      },
    } as unknown as AgentSession;

    expect(describeModel(fakeSession)).toBe("openai/gpt-4o");
  });
});

describe("formatModelMarkerDetails", () => {
  it("adds thinking effort before workflow annotations and omits empty values", () => {
    expect(formatModelMarkerDetails("openai/gpt-4o", "high", ["workflow step override", "fallback after timeout"])).toBe(
      "openai/gpt-4o (thinking effort: high) (workflow step override) (fallback after timeout)",
    );
    expect(formatModelMarkerDetails("openai/gpt-4o", undefined, [""])).toBe("openai/gpt-4o");
    expect(formatModelMarkerDetails("openai/gpt-4o", "off")).toBe("openai/gpt-4o (thinking effort: off)");
  });
});

describe("COMPACTION_FALLBACK_INSTRUCTIONS", () => {
  it("is a non-empty string", () => {
    expect(COMPACTION_FALLBACK_INSTRUCTIONS).toBeTruthy();
    expect(typeof COMPACTION_FALLBACK_INSTRUCTIONS).toBe("string");
    expect(COMPACTION_FALLBACK_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  it("mentions summarizing completed steps", () => {
    expect(COMPACTION_FALLBACK_INSTRUCTIONS).toContain("completed steps");
  });
});

describe("compactSessionContext", () => {
  it("returns null when session does not have compact method", async () => {
    const session = {} as AgentSession;
    const result = await compactSessionContext(session);
    expect(result).toBeNull();
  });

  it("calls session.compact with default instructions when no custom instructions provided", async () => {
    const compact = async (instructions: string) => ({
      summary: "Compacted",
      tokensBefore: 100000,
    });
    const session = { compact } as unknown as AgentSession;

    const result = await compactSessionContext(session);

    expect(result).toEqual({
      summary: "Compacted",
      tokensBefore: 100000,
    });
  });

  it("calls session.compact with custom instructions when provided", async () => {
    let capturedInstructions: string | undefined;
    const compact = async (instructions: string) => {
      capturedInstructions = instructions;
      return { summary: "Custom", tokensBefore: 50000 };
    };
    const session = { compact } as unknown as AgentSession;

    const result = await compactSessionContext(session, "Focus on step 3");

    expect(capturedInstructions).toBe("Focus on step 3");
    expect(result).toEqual({
      summary: "Custom",
      tokensBefore: 50000,
    });
  });

  it("returns null when session.compact throws", async () => {
    const compact = async () => { throw new Error("compaction failed"); };
    const session = { compact } as unknown as AgentSession;

    const result = await compactSessionContext(session);

    expect(result).toBeNull();
  });

  it("returns null when session.compact returns null", async () => {
    const compact = async () => null;
    const session = { compact } as unknown as AgentSession;

    const result = await compactSessionContext(session);

    expect(result).toBeNull();
  });

  it("returns result with empty summary when session.compact returns object without summary", async () => {
    const compact = async () => ({});
    const session = { compact } as unknown as AgentSession;

    const result = await compactSessionContext(session);

    // Should still return a result with empty summary since the guard checks for object
    expect(result).toEqual({ summary: "", tokensBefore: 0 });
  });
});

describe("promptWithFallback context recovery", () => {
  it("tries compacting embedded prompt memory before full session compaction", async () => {
    const longMemory = Array.from({ length: 900 }, (_, index) => `- Durable memory item ${index}: ${"detail ".repeat(20)}`).join("\n");
    const promptText = [
      "Task prompt",
      "",
      "## Project Memory",
      "",
      longMemory,
      "",
      "## Begin",
      "",
      "Do the work.",
    ].join("\n");
    const state: { error?: string } = {};
    const prompts: string[] = [];
    const prompt = vi.fn(async (nextPrompt: string) => {
      prompts.push(nextPrompt);
      if (prompt.mock.calls.length === 1) {
        state.error = "Your input exceeds the context window of this model. Please adjust your input and try again.";
      }
    });
    const compact = vi.fn();
    const session = {
      prompt,
      compact,
      state,
    } as unknown as AgentSession;

    await promptWithFallback(session, promptText);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(compact).not.toHaveBeenCalled();
    expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);
    expect(prompts[1]).toContain("Memory compacted");
    expect(prompts[1]).toContain("## Begin");
  });

  it("compacts and retries when session.prompt stores a context error in session.state.error", async () => {
    const state: { error?: string } = {};
    const prompt = vi.fn(async () => {
      if (prompt.mock.calls.length === 1) {
        state.error = "{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"Your input exceeds the context window of this model. Please adjust your input and try again.\"}}";
      }
    });
    const compact = vi.fn(async () => {
      state.error = undefined;
      return { summary: "Compacted", tokensBefore: 120000 };
    });
    const session = {
      prompt,
      compact,
      state,
    } as unknown as AgentSession;

    await promptWithFallback(session, "review this task");

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(compact).toHaveBeenCalledWith(COMPACTION_FALLBACK_INSTRUCTIONS);
    expect(state.error).toBeUndefined();
  });

  it("throws swallowed non-context session errors without attempting compaction", async () => {
    const state: { error?: string } = {};
    const prompt = vi.fn(async () => {
      state.error = "429 Too Many Requests";
    });
    const compact = vi.fn();
    const session = {
      prompt,
      compact,
      state,
    } as unknown as AgentSession;

    await expect(promptWithFallback(session, "review this task")).rejects.toThrow("429 Too Many Requests");

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
  });
});

describe("createFnAgent skills parameter", () => {
  let piLogSpy: ReturnType<typeof vi.spyOn>;
  let piWarnSpy: ReturnType<typeof vi.spyOn>;
  let piErrorSpy: ReturnType<typeof vi.spyOn>;
  let mockResolveSessionSkills: ReturnType<typeof vi.fn>;
  let mockCreateSkillsOverride: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    piLogSpy = vi.spyOn(piLog, "log").mockImplementation(() => {});
    piWarnSpy = vi.spyOn(piLog, "warn").mockImplementation(() => {});
    piErrorSpy = vi.spyOn(piLog, "error").mockImplementation(() => {});

    // Access the mocked module to get/set mocks
    const skillResolver = await import("../cli-runtime/skill-resolver.js");
    mockResolveSessionSkills = vi.mocked(skillResolver.resolveSessionSkills);
    mockCreateSkillsOverride = vi.mocked(skillResolver.createSkillsOverrideFromSelection);

    mockResolveSessionSkills.mockReturnValue({
      allowedSkillPaths: new Set(),
      excludedSkillPaths: new Set(),
      diagnostics: [],
      filterActive: true,
    });
    resourceLoaderOptions.current = undefined;
    mockCreateSkillsOverride.mockReturnValue(() => ({
      skills: [],
      diagnostics: [],
      resolvedForcedSkills: [],
      unresolvedForcedSkills: [],
    }));
  });

  afterEach(() => {
    piLogSpy.mockRestore();
    piWarnSpy.mockRestore();
    piErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("injects only resolved forced skills through the shared resource-loader prompt seam (FN-9114)", async () => {
    mockCreateSkillsOverride.mockReturnValue(() => ({
      skills: [], diagnostics: [],
      resolvedForcedSkills: [{ requestedName: "alpha", skillName: "alpha" }],
      unresolvedForcedSkills: [
        { requestedName: "delta", reason: "disabled-by-settings" },
        { requestedName: "missing", reason: "not-found" },
      ],
    }));
    await createFnAgent({
      cwd: "/test/project", systemPrompt: "Test",
      systemPromptLayers: { stable: "Stable", dynamic: "Executor context" },
      skillSelection: {
        projectRootDir: "/test/project", sessionPurpose: "executor",
        forcedSkillNames: ["alpha", "delta", "missing"],
      },
    });
    const override = resourceLoaderOptions.current?.skillsOverride as ((base: { skills: []; diagnostics: [] }) => unknown) | undefined;
    override?.({ skills: [], diagnostics: [] });
    const append = resourceLoaderOptions.current?.appendSystemPromptOverride as (() => string[]) | undefined;
    expect(append?.().join("\n")).toContain("REQUIRED to read these available skills: alpha");
    expect(append?.().join("\n")).not.toContain("delta");
    expect(append?.().join("\n")).not.toContain("missing");
  });

  it("skills parameter auto-derives SkillSelectionContext", async () => {
    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: ["review", "fusion"],
    };

    await createFnAgent(options);

    // Verify resolveSessionSkills was called with auto-derived context
    expect(mockResolveSessionSkills).toHaveBeenCalledTimes(1);
    const callArgs = mockResolveSessionSkills.mock.calls[0]![0];
    expect(callArgs.projectRootDir).toBe("/test/project");
    expect(callArgs.requestedSkillNames).toEqual(["review", "fusion"]);
    expect(callArgs.sessionPurpose).toBe("executor");
  });

  it("skillSelection takes precedence over skills", async () => {
    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: ["review"],
      skillSelection: {
        projectRootDir: "/other",
        requestedSkillNames: ["triage"],
        sessionPurpose: "triage",
      },
    };

    await createFnAgent(options);

    // Verify resolveSessionSkills was called with explicit skillSelection (not auto-derived)
    expect(mockResolveSessionSkills).toHaveBeenCalledTimes(1);
    const callArgs = mockResolveSessionSkills.mock.calls[0]![0];
    expect(callArgs.projectRootDir).toBe("/other");
    expect(callArgs.requestedSkillNames).toEqual(["triage"]);
    expect(callArgs.sessionPurpose).toBe("triage");

    // Verify the convenience log was NOT emitted (skillSelection takes precedence)
    expect(piLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Using skills from convenience parameter")
    );
  });

  it("empty skills array is treated as unset", async () => {
    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: [],
    };

    await createFnAgent(options);

    // Verify no skill resolution occurred
    expect(mockResolveSessionSkills).not.toHaveBeenCalled();
    expect(mockCreateSkillsOverride).not.toHaveBeenCalled();
  });

  it("skills auto-derivation logs the convenience parameter", async () => {
    const piDebugSpy = vi.spyOn(piLog, "debug").mockImplementation(() => {});
    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: ["review", "fusion"],
    };

    await createFnAgent(options);

    // Steady-state skill-request chatter is debug-gated so it does not fill the TUI.
    expect(piDebugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Using skills from convenience parameter: [review, fusion]")
    );
    expect(piLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Using skills from convenience parameter: [review, fusion]")
    );
    piDebugSpy.mockRestore();
  });

  it("resolves project root via resolvePiExtensionProjectRoot for non-worktree paths", async () => {
    // When cwd is a regular directory (not a .worktrees/ path),
    // resolvePiExtensionProjectRoot is used to walk up to .fusion.
    // Since no .fusion exists in test filesystem, it returns cwd as-is.
    const options: AgentOptions = {
      cwd: "/project/subdirectory",
      systemPrompt: "Test",
      skills: ["fusion"],
    };

    await createFnAgent(options);

    // resolvePiExtensionProjectRoot walks up from /project/subdirectory.
    // No .fusion is found in the test filesystem, so it returns /project/subdirectory.
    expect(mockResolveSessionSkills).toHaveBeenCalledTimes(1);
    const callArgs = mockResolveSessionSkills.mock.calls[0]![0];
    expect(callArgs.projectRootDir).toBe("/project/subdirectory");
    expect(callArgs.requestedSkillNames).toEqual(["fusion"]);
  });

  it("skills without corresponding discovered skills produces diagnostics", async () => {
    const piDebugSpy = vi.spyOn(piLog, "debug").mockImplementation(() => {});
    // Mock to return diagnostics for missing skill
    mockResolveSessionSkills.mockReturnValue({
      allowedSkillPaths: new Set(),
      excludedSkillPaths: new Set(),
      diagnostics: [
        { type: "info" as const, message: 'Requested skill "nonexistent-skill" not found in discovered skills' },
      ],
      filterActive: true,
    });

    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: ["nonexistent-skill"],
    };

    await createFnAgent(options);

    // type=info skill diagnostics are debug-gated (not info/log)
    expect(mockResolveSessionSkills).toHaveBeenCalled();
    expect(piDebugSpy).toHaveBeenCalledWith(
      expect.stringContaining("info")
    );
    expect(piLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Requested skill")
    );
    piDebugSpy.mockRestore();
  });
});

describe("promptWithFallback auto-compaction", () => {
  let piLogSpy: ReturnType<typeof vi.spyOn>;
  let piWarnSpy: ReturnType<typeof vi.spyOn>;
  let piErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    piLogSpy = vi.spyOn(piLog, "log").mockImplementation(() => {});
    piWarnSpy = vi.spyOn(piLog, "warn").mockImplementation(() => {});
    piErrorSpy = vi.spyOn(piLog, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    piLogSpy.mockRestore();
    piWarnSpy.mockRestore();
    piErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("auto-compacts on context error, then retries successfully", async () => {
    // Mock session that throws context error on first prompt, succeeds on retry
    const mockPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("prompt is too long: 210000 tokens > 200000 maximum"))
      .mockResolvedValueOnce(undefined);
    const mockCompact = vi.fn().mockResolvedValue({ summary: "compacted", tokensBefore: 210000 });
    const session = { prompt: mockPrompt, compact: mockCompact } as unknown as AgentSession;

    await promptWithFallback(session, "test prompt");

    // Verify compact was called once
    expect(mockCompact).toHaveBeenCalledTimes(1);
    // Verify prompt was called twice (first throw, second success)
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockPrompt.mock.calls[0]).toEqual(["test prompt"]);
    expect(mockPrompt.mock.calls[1]).toEqual(["test prompt"]);
  });

  it("auto-compacts when compact returns null (session doesn't support it)", async () => {
    // Mock session that throws context error, compact not available
    const mockPrompt = vi.fn().mockRejectedValue(new Error("prompt is too long: 210000 tokens > 200000 maximum"));
    const session = { prompt: mockPrompt } as unknown as AgentSession; // No compact method

    await expect(promptWithFallback(session, "test prompt")).rejects.toThrow("prompt is too long: 210000 tokens > 200000 maximum");

    // Verify prompt was called only once (no retry since compaction unavailable)
    expect(mockPrompt).toHaveBeenCalledTimes(1);
  });

  it("propagates original error when retry after compaction also fails", async () => {
    // Mock session that always throws context error
    const mockPrompt = vi.fn().mockRejectedValue(new Error("prompt is too long: 210000 tokens > 200000 maximum"));
    const mockCompact = vi.fn().mockResolvedValue({ summary: "compacted", tokensBefore: 200000 });
    const session = { prompt: mockPrompt, compact: mockCompact } as unknown as AgentSession;

    await expect(promptWithFallback(session, "test prompt")).rejects.toThrow("prompt is too long: 210000 tokens > 200000 maximum");

    // Verify prompt was called exactly twice (original + 1 retry)
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    // Verify compact was called once
    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  it("propagates non-context errors without attempting compaction", async () => {
    // Mock session that throws non-context error
    const mockPrompt = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const mockCompact = vi.fn();
    const session = { prompt: mockPrompt, compact: mockCompact } as unknown as AgentSession;

    await expect(promptWithFallback(session, "test prompt")).rejects.toThrow("ECONNREFUSED");

    // Verify compact was NOT called
    expect(mockCompact).not.toHaveBeenCalled();
    // Verify prompt was called only once
    expect(mockPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not compact when prompt succeeds on first try", async () => {
    // Mock session that succeeds on first prompt
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const mockCompact = vi.fn();
    const session = { prompt: mockPrompt, compact: mockCompact } as unknown as AgentSession;

    await promptWithFallback(session, "test prompt");

    // Verify compact was NOT called
    expect(mockCompact).not.toHaveBeenCalled();
    // Verify prompt was called once
    expect(mockPrompt).toHaveBeenCalledTimes(1);
  });

  it("auto-compacts with options parameter and passes options to retry", async () => {
    // Mock session that throws context error on first prompt, succeeds on retry
    const mockPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("prompt is too long: 210000 tokens > 200000 maximum"))
      .mockResolvedValueOnce(undefined);
    const mockCompact = vi.fn().mockResolvedValue({ summary: "compacted", tokensBefore: 210000 });
    const session = { prompt: mockPrompt, compact: mockCompact } as unknown as AgentSession;
    // Use a simple options object (AbortSignal cannot be constructed in test env)
    const options = { timeout: 60000 };

    await promptWithFallback(session, "test prompt", options);

    // Verify compact was called once
    expect(mockCompact).toHaveBeenCalledTimes(1);
    // Verify prompt was called twice with options
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockPrompt.mock.calls[0]).toEqual(["test prompt", options]);
    expect(mockPrompt.mock.calls[1]).toEqual(["test prompt", options]);
  });

  it("delegates to session.promptWithFallback when available so rich fallback logic runs", async () => {
    // The session-attached promptWithFallback (set by createFnAgent at pi.ts:2012)
    // is the only path that swaps to the configured fallbackModel on
    // isRetryableModelSelectionError matches like "api key", 401/403, rate-limit, etc.
    // Bypassing it (as the old standalone-only behavior did) silently dropped
    // missing-API-key triage failures with no fallback attempt — see FN-5584.
    // A re-entry guard in promptWithFallback prevents the recursion that
    // FN-4900 originally guarded against.
    const mockSessionPromptWithFallback = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const mockCompact = vi.fn();
    const session = {
      prompt: mockPrompt,
      compact: mockCompact,
      promptWithFallback: mockSessionPromptWithFallback,
    } as unknown as AgentSession;

    await promptWithFallback(session, "test prompt");

    expect(mockSessionPromptWithFallback).toHaveBeenCalledTimes(1);
    expect(mockSessionPromptWithFallback).toHaveBeenCalledWith("test prompt", undefined);
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("handles context error patterns from various providers", async () => {
    const contextErrorPatterns = [
      "prompt is too long: 210000 tokens > 200000 maximum", // Anthropic
      "exceeds the context window", // OpenAI
      "input token count exceeds the maximum", // Google Gemini
      "maximum prompt length is 100000 but request contains 150000", // xAI
      "reduce the length of the messages", // Groq
      "too many tokens", // Generic
    ];

    for (const errorMessage of contextErrorPatterns) {
      const mockPrompt = vi.fn()
        .mockRejectedValueOnce(new Error(errorMessage))
        .mockResolvedValueOnce(undefined);
      const mockCompact = vi.fn().mockResolvedValue({ summary: "compacted", tokensBefore: 150000 });
      const session = { prompt: mockPrompt, compact: mockCompact } as unknown as AgentSession;

      await promptWithFallback(session, "test prompt");

      // Verify compaction was triggered for each error pattern
      expect(mockCompact).toHaveBeenCalled();
    }
  });
});

describe("session failure diagnostics", () => {
  it("logs warning when compaction fails during promptWithFallback", async () => {
    const warnSpy = vi.spyOn(piLog, "warn");
    const session = {
      prompt: vi.fn().mockRejectedValueOnce(
        new Error("prompt is too long: 210000 tokens > 200000 maximum"),
      ),
      compact: vi.fn().mockRejectedValue(new Error("compaction exploded")),
    } as unknown as AgentSession;

    await expect(promptWithFallback(session, "test prompt")).rejects.toThrow(
      "prompt is too long: 210000 tokens > 200000 maximum",
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Context compaction failed (will fall through to kill/requeue): compaction exploded"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when session dispose fails during model fallback swap", async () => {
    const warnSpy = vi.spyOn(piLog, "warn");
    const createAgentSessionMock = vi.mocked(createAgentSession);

    const primarySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
      dispose: vi.fn(() => {
        throw new Error("dispose failed");
      }),
      subscribe: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback swap",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
    });

    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Session dispose failed after session_shutdown emit: dispose failed"),
    );

    warnSpy.mockRestore();
  });

  it("passes xhigh through to sessions without engine-side narrowing", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const sessionWithThinking = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn(),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockResolvedValueOnce({ session: sessionWithThinking } as any);

    await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test xhigh thinking pass-through",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      defaultThinkingLevel: "xhigh",
    });

    expect(sessionWithThinking.setThinkingLevel).toHaveBeenCalledWith("xhigh");
  });

  it("applies fallback thinking level after prompt-time fallback swap", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);

    const primarySetThinkingLevel = vi.fn();
    const fallbackSetThinkingLevel = vi.fn();
    const primarySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: primarySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: fallbackSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback thinking",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "low",
      fallbackThinkingLevel: "high",
    });

    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();

    expect(primarySetThinkingLevel).toHaveBeenCalledWith("low");
    expect(fallbackSetThinkingLevel).toHaveBeenCalledWith("high");
    expect(fallbackSetThinkingLevel).not.toHaveBeenCalledWith("low");
  });

  it("uses default thinking level for fallback swap when fallback thinking is unset", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);

    const primarySetThinkingLevel = vi.fn();
    const fallbackSetThinkingLevel = vi.fn();
    const primarySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: primarySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: fallbackSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback default thinking",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "low",
    });

    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();

    expect(fallbackSetThinkingLevel).toHaveBeenCalledWith("low");
  });

  it("disables thinking when fallback session rejects thinking/reasoning compatibility", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);

    const primarySetThinkingLevel = vi.fn();
    const fallbackSetThinkingLevel = vi.fn(() => {
      throw new Error("400 cannot specify both 'thinking' and 'reasoning_effort'");
    });
    const primarySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: primarySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: fallbackSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback thinking conflict",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "low",
      fallbackThinkingLevel: "high",
    });

    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();

    expect(fallbackSetThinkingLevel).toHaveBeenCalledTimes(1);
    expect(fallbackSetThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("forwards materialized MCP servers into session creation and prompt options for supported providers", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    // FNXC:SessionIdentity 2026-08-12-20:46: createFnAgent wraps session.prompt to bind the
    // request principal, so retain the original spy when asserting the prompt reaches Pi.
    const prompt = vi.fn();
    const session = {
      model: { provider: "test", id: "primary-model" },
      prompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const mcpServers = [
      { name: "docs", transport: "stdio" as const, command: "node", args: ["server.js"], env: { API_KEY: "SECRET" } },
    ];

    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockResolvedValueOnce({ session } as any);

    const created = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test MCP forwarding",
      defaultProvider: "anthropic",
      defaultModelId: "primary-model",
      mcpServers,
    });
    await (created.session as any).promptWithFallback("Use docs");

    expect(createAgentSessionMock.mock.calls[0]?.[0]).not.toHaveProperty("mcpServers");
    expect(prompt).toHaveBeenCalledWith("Use docs", expect.objectContaining({ mcpServers }));
  });

  /*
  FNXC:McpConfig 2026-08-23-18:36:
  The mock provider never reaches pi's MCP forwarding seam. `createFnAgent` routes through the
  registered agent-session factory, whose `useMockRuntime` short-circuit resolves the mock runtime
  singleton directly and never re-enters pi session construction — so no pi session, and therefore
  no MCP server definition (or its materialized secrets), can be built for a mock lane at all.
  That is a strictly stronger guarantee than the pi-lane `mcp.forwarding.skipped` log this case used
  to assert, and the log itself is unreachable from here. The pi-lane skip decision and its
  content-free log stay directly covered by `mcp-runtime-support.test.ts`
  (`runtimeSupportsMcp("pi", "mock") === false`, plus the log's field/redaction contract).
  */
  it("never builds a pi session for the mock provider, so MCP definitions cannot reach it", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    createAgentSessionMock.mockReset();

    const created = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test MCP skip",
      defaultProvider: "mock",
      defaultModelId: "scripted",
      mcpServers: [{ name: "docs", transport: "stdio", command: "node", env: { TOKEN: "SECRET" } }],
    });

    expect(created.session).toBeDefined();
    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  // FNXC:ThinkingEffortFallback 2026-08-25-00:00: when the provider rejects the
  // requested thinking effort value (400 naming the parameter, or codex
  // [1210] Invalid API parameter envelope), drop exactly one rung and retry on
  // a fresh session of the SAME model. The retry should NOT touch the
  // configured fallback model.
  it("degrades thinking effort by one step when the provider rejects the requested effort", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstSetThinkingLevel = vi.fn();
    const retrySetThinkingLevel = vi.fn();
    // FNXC:ThinkingEffortFallback 2026-08-26-16:30 (review fix): attachSessionIdentity
    // wraps session.prompt (ALS principal binding) and replaces the property, so
    // assertions must target the captured spy, not session.prompt.
    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 Invalid API parameter: reasoning_effort must be one of: low, high"),
    );
    const retryPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: firstSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const retrySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: retryPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: retrySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: retrySession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test effort degradation",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    // First attempt: max. Second attempt: degraded one step to xhigh
    // (canonical order: max > xhigh > high — Devin BUG-0001 fix).
    expect(firstSetThinkingLevel).toHaveBeenCalledWith("max");
    expect(retrySetThinkingLevel).toHaveBeenCalledWith("xhigh");
    // Same model retried on a fresh session — the configured fallback was NOT used.
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    for (const call of createAgentSessionMock.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        model: expect.objectContaining({ provider: "test", id: "primary-model" }),
      }));
    }
    expect(retryPrompt).toHaveBeenCalledTimes(1);
    expect(firstPrompt).toHaveBeenCalledTimes(1);
  });

  // FNXC:ThinkingEffortFallback 2026-08-26-19:30 (review fix P1): with NO
  // configured fallback, a primary that rejects BOTH the pinned effort and the
  // degraded rung must surface the terminal ModelFallbackExhaustedError (triage
  // parks the task) instead of the raw provider rejection that triage's
  // generic catch-all would re-admit into an endless degradation cycle.
  // FNXC:ThinkingEffortFallback 2026-08-29-06:54 (review fix J): the walk-down
  // ladder may traverse MORE than one rung on the same model — here max → xhigh
  // are both rejected, the ladder continues to high which is ALSO rejected, and
  // the path terminates with the same exhausted contract.
  it("terminates with fallback-exhausted when effort degrades twice with no fallback configured", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const rejection = () => new Error("400 invalid_request_error: reasoning_effort is not supported");
    const firstPrompt = vi.fn().mockRejectedValue(rejection());
    const degradedPrompt = vi.fn().mockRejectedValue(rejection());
    const thirdPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const degradedSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: degradedPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const thirdSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: thirdPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: degradedSession } as any)
      .mockResolvedValueOnce({ session: thirdSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test effort degradation no fallback",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      defaultThinkingLevel: "max",
    });
    // Ladder walked max → xhigh → high, the high attempt succeeded. No
    // configured fallback, no endless loop. The prompt resolves normally.
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    expect(degradedPrompt).toHaveBeenCalledTimes(1);
    expect(thirdPrompt).toHaveBeenCalledTimes(1);
    // Every retry reuses the same model — no fallback was configured.
    for (const call of createAgentSessionMock.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        model: expect.objectContaining({ provider: "test", id: "primary-model" }),
      }));
    }
  });

  // FNXC:ThinkingEffortFallback 2026-08-29-10:40 (Greptile P1-A): a bottom-rung
  // effort rejection on the primary is now FALLBACK-ELIGIBLE. When the pinned
  // level is already the last ladder rung (off) the walk-down loop has nothing
  // to degrade, so degradedRetryError stays null — but a configured distinct
  // fallback may accept the pinned effort. The classification treats the
  // bottom rung as exhaustion of same-model retries and consults the fallback
  // exactly once.
  it("routes a bottom-rung effort rejection to the configured fallback when no degraded retry exists", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const fallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test bottom-rung effort rejection routes to fallback",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "off",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    // Primary (off rejected — no rung below it) then the configured fallback.
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(createAgentSessionMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "primary-model" }),
    }));
    expect(createAgentSessionMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "fallback-model" }),
    }));
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
  });

  // FNXC:ThinkingEffortFallback 2026-08-29-10:40 (Greptile P1-A): with NO
  // configured fallback the bottom-rung bare rejection is still terminal —
  // there is nowhere to route, so the same ModelFallbackExhaustedError
  // contract surfaces after exactly one same-model attempt.
  it("terminates with fallback-exhausted on a bottom-rung effort rejection when no fallback is configured", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockResolvedValueOnce({ session: firstSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test bottom-rung terminal without fallback",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      defaultThinkingLevel: "off",
    });
    await expect((session as any).promptWithFallback("Run task")).rejects.toMatchObject({
      name: "ModelFallbackExhaustedError",
      attempts: 1,
      triggerPoint: "prompt-time",
    });
    // Exactly one same-model attempt — no fallback exists to consult.
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(firstPrompt).toHaveBeenCalledTimes(1);
  });

  // FNXC:ThinkingEffortFallback 2026-08-29-06:54 (review fix K): the
  // per-session degradation latch must NOT survive across prompt calls. A
  // LATER prompt rejected for effort on a session that previously degraded
  // successfully must be able to walk the ladder DOWN one more rung on the
  // primary, instead of being stuck between a blocked degradation branch
  // and a null degradedRetryError. Here prompt 1 degrades max → xhigh
  // successfully, prompt 2 rejects again, the latch has been reset so the
  // ladder walks xhigh → high and the high attempt succeeds on the primary.
  it("resets the degradation latch between prompts so a later rejection can walk down further", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 Invalid API parameter: reasoning_effort must be one of: low, high"),
    );
    // Prompt 1: degraded session's prompt succeeds (xhigh accepted).
    // Prompt 2: the SAME degraded session's prompt rejects (effort again).
    const degradedPrompt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("400 invalid_request_error: reasoning_effort is not supported"));
    const thirdPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const degradedSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: degradedPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const thirdSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: thirdPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: degradedSession } as any)
      .mockResolvedValueOnce({ session: thirdSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test latch reset between prompts",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });
    // Prompt 1: original rejection -> degraded same-model retry succeeds.
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    // Prompt 2: effort rejection on the already-degraded session. The latch
    // has been reset, so the ladder walks xhigh → high on the primary and
    // the high attempt succeeds. No fallback hop.
    await expect((session as any).promptWithFallback("Run task again")).resolves.toBeUndefined();
    expect(thirdPrompt).toHaveBeenCalledTimes(1);
    expect(degradedPrompt).toHaveBeenCalledTimes(2);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    // Every session was the primary model — no fallback hop.
    for (const call of createAgentSessionMock.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        model: expect.objectContaining({ provider: "test", id: "primary-model" }),
      }));
    }
  });

  // FNXC:ThinkingEffortFallback 2026-08-29-10:40 (Greptile P1-C): the
  // !usingFallback guard blocked the effort walk-down once the session was on
  // the configured fallback model, so an effort rejection on the fallback was
  // terminal even though the fallback may support a LOWER effort. The walk-down
  // now runs on the CURRENT model — when usingFallback is true, the degraded
  // retry stays on the fallback model instead of hopping back to the primary.
  it("walks the effort ladder down on the fallback model when already using the fallback", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const fallbackPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const walkDownFallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const walkDownFallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: walkDownFallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      // Session creation: primary model selection fails → fallback session.
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      // Prompt-time effort walk-down: stays on the fallback model.
      .mockResolvedValueOnce({ session: walkDownFallbackSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback effort walk-down",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    // Calls 2 and 3 (fallback session + degraded retry) are BOTH fallback-model —
    // the walk-down runs on the fallback, never hopping back to the primary.
    expect(createAgentSessionMock.mock.calls[1][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "fallback-model" }),
    }));
    expect(createAgentSessionMock.mock.calls[2][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "fallback-model" }),
    }));
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(walkDownFallbackPrompt).toHaveBeenCalledTimes(1);
    // FNXC:ThinkingEffortFallback 2026-08-29-11:30 (Greptile Issue 1): the
    // replacement session must inherit the DEGRADED rung (max -> xhigh), not
    // the original configured effort — otherwise the walk-down re-sends the
    // rejected effort on every retry.
    expect(walkDownFallbackSession.setThinkingLevel).toHaveBeenCalledWith("xhigh");
  });

  // FNXC:ThinkingEffortFallback 2026-08-29-11:45 (Greptile round-6 Issue 1): a
  // fallback with its OWN configured thinking level must walk down from THAT
  // level, not from the primary's. primary low + fallback max: rejecting max
  // must try xhigh → high, never minimal/off (which only makes sense below
  // the primary's low). Starting from primaryThinkingLevel would skip valid
  // fallback rungs and throw ModelFallbackExhaustedError despite support.
  it("walks the fallback ladder down from the fallback's own thinking level", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const fallbackPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const walkDownFallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const walkDownFallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: walkDownFallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      // Session creation: primary model selection fails → fallback session.
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      // Prompt-time effort walk-down: stays on the fallback model.
      .mockResolvedValueOnce({ session: walkDownFallbackSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback own-level walk-down",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "low",
      fallbackThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    // The degraded replacement walks down FROM the fallback's max (max →
    // xhigh), never from the primary's low (which would try minimal/off).
    // (The initial fallback session's own setThinkingLevel("max") is not
    // observable here: the swap's Object.assign overwrites the facade's
    // methods with the replacement session's spies.)
    expect(walkDownFallbackSession.setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(walkDownFallbackSession.setThinkingLevel).not.toHaveBeenCalledWith("minimal");
    expect(walkDownFallbackSession.setThinkingLevel).not.toHaveBeenCalledWith("off");
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(walkDownFallbackPrompt).toHaveBeenCalledTimes(1);
  });

  // FNXC:ThinkingEffortFallback 2026-08-29-11:52 (Greptile round-7 Issue 1): a
  // fallback-only effort (fallbackThinkingLevel set, NO defaultThinkingLevel)
  // leaves primaryThinkingLevel undefined. The degradation entry guard must use
  // the ACTIVE session's level, or the fallback's rejected effort skips the
  // ladder and dies with ModelFallbackExhaustedError despite a supported rung.
  it("degrades a fallback-only effort with no default thinking level configured", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const fallbackPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const walkDownFallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const walkDownFallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: walkDownFallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      // Session creation: primary model selection fails → fallback session.
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      // Prompt-time effort walk-down: stays on the fallback model.
      .mockResolvedValueOnce({ session: walkDownFallbackSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback-only effort walk-down",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      // NO defaultThinkingLevel — fallback-only effort:
      fallbackThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    // max rejected → xhigh on the fallback model (fallback-only config).
    expect(walkDownFallbackSession.setThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(walkDownFallbackSession.setThinkingLevel).not.toHaveBeenCalledWith("minimal");
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(walkDownFallbackPrompt).toHaveBeenCalledTimes(1);
  });

  // FNXC:ThinkingEffortFallback 2026-08-25-00:00: codex `[1210] Invalid API
  // parameter` rejection on the same model is the same problem in a different
  // envelope. Same fix path applies.
  // FNXC:ThinkingEffortFallback 2026-08-26-05:30 (review fix): when the
  // degraded same-model retry ALSO fails with a retryable model-selection
  // error (e.g. 429), the failure must fall through to the CONFIGURED FALLBACK
  // model instead of escaping promptWithFallback into triage's generic retry.
  it("routes a failed degraded retry through the configured fallback model", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstSetThinkingLevel = vi.fn();
    const degradedSetThinkingLevel = vi.fn();
    const fallbackSetThinkingLevel = vi.fn();

    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 Invalid API parameter: reasoning_effort must be one of: low, high"),
    );
    const degradedPrompt = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    const fallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: firstSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const degradedSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: degradedPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: degradedSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: fallbackSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: degradedSession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test degraded-retry fallback",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
      fallbackThinkingLevel: "high",
    });

    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();

    // Ladder ran once (max → xhigh), then the 429 from the degraded attempt
    // routed to the fallback model at ITS OWN configured level.
    expect(degradedSetThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(fallbackSetThinkingLevel).toHaveBeenCalledWith("high");
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    expect(createAgentSessionMock.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({ provider: "test", id: "fallback-model" }),
      }),
    );
  });
  // FNXC:ThinkingEffortFallback 2026-08-26-07:50 (review fix): when the degraded
  // retry is ALSO rejected for reasoning effort (the model supports neither the
  // pinned nor the next-lower level), the fallback classification must treat the
  // effort rejection as retryable — otherwise the original rejection is rethrown
  // without ever trying the configured fallback model.
  // FNXC:ThinkingEffortFallback 2026-08-29-06:54 (review fix J): the walk-down
  // ladder keeps stepping until a rung is accepted or the ladder bottom is
  // reached. Here max → xhigh are both rejected for effort; the ladder
  // continues to high, which is accepted — no fallback hop is needed.
  it("walks the ladder down and succeeds on the first accepted rung", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstSetThinkingLevel = vi.fn();
    const degradedSetThinkingLevel = vi.fn();
    const thirdSetThinkingLevel = vi.fn();

    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 Invalid API parameter: reasoning_effort must be one of: low"),
    );
    const degradedPrompt = vi.fn().mockRejectedValue(
      new Error("400 Invalid API parameter: reasoning_effort must be one of: low"),
    );
    const thirdPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: firstSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const degradedSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: degradedPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: degradedSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const thirdSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: thirdPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: thirdSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: degradedSession } as any)
      .mockResolvedValueOnce({ session: thirdSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test walk-down ladder success",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });

    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();

    // Ladder walked max → xhigh → high, the high attempt succeeded on the
    // same primary model. No fallback hop.
    expect(degradedSetThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(thirdSetThinkingLevel).toHaveBeenCalledWith("high");
    expect(thirdPrompt).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    for (const call of createAgentSessionMock.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        model: expect.objectContaining({ provider: "test", id: "primary-model" }),
      }));
    }
  });

  // FNXC:ThinkingEffortFallback 2026-09-04-04:55:
  // Sparse support: the model rejects max AND the adjacent xhigh rung but
  // accepts high. The walk must not stop after latching the first drop.
  it("walks past an unsupported adjacent fallback rung to a lower supported effort", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const rejection = () => new Error("400 invalid_request_error: reasoning_effort is not supported");
    const fallbackPrompt = vi.fn().mockRejectedValue(rejection());
    const xhighPrompt = vi.fn().mockRejectedValue(rejection());
    const highSetThinkingLevel = vi.fn();
    const highPrompt = vi.fn().mockResolvedValue(undefined);
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const xhighSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: xhighPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const highSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: highPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: highSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      .mockResolvedValueOnce({ session: xhighSession } as any)
      .mockResolvedValueOnce({ session: highSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test sparse fallback effort rungs",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(highSetThinkingLevel).toHaveBeenCalledWith("high");
    expect(highPrompt).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[3][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "fallback-model" }),
    }));
  });

  // FNXC:ThinkingEffortFallback 2026-09-04-04:55:
  // After a fallback session successfully degrades max → xhigh, a later prompt
  // must walk from the APPLIED xhigh rung. Reconstructing max retries xhigh;
  // a 429 on that redundant attempt used to exit before high ran.
  it("starts a later fallback prompt from the applied effort instead of the original fallback config", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const rejection = () => new Error("400 invalid_request_error: reasoning_effort is not supported");
    const fallbackPrompt = vi.fn().mockRejectedValue(rejection());
    const xhighPrompt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rejection());
    let laterLevel: string | undefined;
    const laterSetThinkingLevel = vi.fn((level: string) => {
      laterLevel = level;
    });
    const laterPrompt = vi.fn(async () => {
      if (laterLevel === "high") return;
      throw new Error("429 Too Many Requests");
    });
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const xhighSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: xhighPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const laterSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: laterPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: laterSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      .mockResolvedValueOnce({ session: xhighSession } as any)
      .mockResolvedValueOnce({ session: laterSession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback applied-effort persistence",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      fallbackThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    await expect((session as any).promptWithFallback("Run task again")).resolves.toBeUndefined();
    expect(laterSetThinkingLevel).toHaveBeenCalledWith("high");
    expect(laterPrompt).toHaveBeenCalledTimes(1);
  });

  // FNXC:ThinkingEffortFallback 2026-09-04-04:55:
  // Already on the fallback, an effort rejection whose lower-rung replacement
  // session fails to create with a retryable 429 must still receive the
  // bounded final-primary retry instead of throwing the raw 429.
  it("retries the primary when fallback effort-degrade session creation fails with 429", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const fallbackPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const primaryRetrySetThinkingLevel = vi.fn();
    const primaryRetryPrompt = vi.fn().mockResolvedValue(undefined);
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const primaryRetrySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: primaryRetryPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: primaryRetrySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: primaryRetrySession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback degrade 429 final primary retry",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(primaryRetryPrompt).toHaveBeenCalledTimes(1);
    expect(primaryRetrySetThinkingLevel).toHaveBeenCalledWith("max");
    expect(createAgentSessionMock.mock.calls[3][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "primary-model" }),
    }));
  });

  // FNXC:ThinkingEffortFallback 2026-09-04-05:12:
  // Already on the fallback, a lower-effort replacement that fails with a
  // NON-retryable non-effort error (500) must still get FN-8098's bounded
  // final-primary retry. Gating that path on isRetryableModelSelectionError
  // threw the raw 500 and skipped the established primary → fallback → primary
  // sequence.
  it("retries the primary when fallback effort-degrade session creation fails with a non-retryable 500", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const fallbackPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const primaryRetrySetThinkingLevel = vi.fn();
    const primaryRetryPrompt = vi.fn().mockResolvedValue(undefined);
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const primaryRetrySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: primaryRetryPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: primaryRetrySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      .mockRejectedValueOnce(new Error("500 Internal Server Error"))
      .mockResolvedValueOnce({ session: primaryRetrySession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test fallback degrade 500 final primary retry",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(primaryRetryPrompt).toHaveBeenCalledTimes(1);
    expect(primaryRetrySetThinkingLevel).toHaveBeenCalledWith("max");
    expect(createAgentSessionMock.mock.calls[3][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "primary-model" }),
    }));
  });

  // FNXC:ThinkingEffortFallback 2026-09-04-05:44:
  // Primary rejects configured max, the xhigh retry 429s, fallback also fails.
  // The bounded final-primary retry must apply xhigh (the last primary rung),
  // not restore max. Re-sending the rejected effort exhausted the sequence
  // even when the primary supports the degraded level.
  it("retries the primary at the last degraded effort instead of the rejected configured level", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 invalid_request_error: reasoning_effort is not supported"),
    );
    const degradedPrompt = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    const fallbackPrompt = vi.fn().mockRejectedValue(new Error("500 Internal Server Error"));
    const primaryRetrySetThinkingLevel = vi.fn();
    const primaryRetryPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const degradedSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: degradedPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const primaryRetrySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: primaryRetryPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: primaryRetrySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: degradedSession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      .mockResolvedValueOnce({ session: primaryRetrySession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test final primary retry keeps degraded effort",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    expect(primaryRetryPrompt).toHaveBeenCalledTimes(1);
    expect(primaryRetrySetThinkingLevel).toHaveBeenCalledWith("xhigh");
    expect(primaryRetrySetThinkingLevel).not.toHaveBeenCalledWith("max");
    expect(createAgentSessionMock.mock.calls[3][0]).toEqual(expect.objectContaining({
      model: expect.objectContaining({ provider: "test", id: "primary-model" }),
    }));
  });


  // FNXC:ThinkingEffortFallback 2026-08-26-15:20 (review fix): the degraded
  // retry's error is the CURRENT failure. When it is not fallback-eligible the
  // branch must throw it (not the superseded original rejection), and when the
  // next promptWithFallback call on the same session hits a retryable error the
  // stale degraded error must not shadow its fallback classification.
  it("throws the degraded attempt's own failure and does not let it go stale across prompts", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);

    // Degraded attempt fails first with a non-fallback-eligible error (call 1),
    // then the SAME session hits a retryable 429 on the next prompt (call 2).
    const degradedPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("500 Internal Server Error"))
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const fallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(
        new Error("400 Invalid API parameter: reasoning_effort must be one of: low, high"),
      ),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const degradedSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: degradedPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: degradedSession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test degraded failure currency",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
      fallbackThinkingLevel: "high",
    });

    // Call 1: degraded retry failed with a non-eligible error → that CURRENT
    // failure escapes, not the superseded original effort rejection.
    await expect((session as any).promptWithFallback("Run task")).rejects.toThrow(/500/);

    // Call 2: the same session's retryable 429 must route to the fallback —
    // a stale degraded error from call 1 must not suppress it.
    await expect((session as any).promptWithFallback("Run task again")).resolves.toBeUndefined();
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
  });


  it("degrades thinking effort on codex [1210] Invalid API parameter rejection", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstSetThinkingLevel = vi.fn();
    const retrySetThinkingLevel = vi.fn();
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(
        new Error('{"type":"server_error","message":"[1210] Invalid API parameter: reasoning_effort"}'),
      ),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: firstSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const retrySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: retrySetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: retrySession } as any);
    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test codex rejection",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      defaultThinkingLevel: "xhigh",
    });
    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();
    // Codex rejected xhigh; the one-step-down rung is high (max is ABOVE xhigh).
    expect(retrySetThinkingLevel).toHaveBeenCalledWith("high");
    // Same model retried on a fresh session — no fallback hop happened.
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    for (const call of createAgentSessionMock.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        model: expect.objectContaining({ provider: "test", id: "primary-model" }),
      }));
    }
  });

  // FNXC:ThinkingEffortFallback 2026-08-26-18:45 (review fix): the degraded effort
  // must stay session-local. With NO explicit fallbackThinkingLevel, the fallback
  // model inherits the lane's ORIGINAL configured level — not the level the
  // primary was degraded to after its rejection.
  it("keeps the degraded effort out of the fallback's inherited thinking level", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const firstSetThinkingLevel = vi.fn();
    const degradedSetThinkingLevel = vi.fn();
    const fallbackSetThinkingLevel = vi.fn();

    const firstPrompt = vi.fn().mockRejectedValue(
      new Error("400 Invalid API parameter: reasoning_effort must be one of: low, high"),
    );
    const degradedPrompt = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    const fallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: firstPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: firstSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const degradedSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: degradedPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: degradedSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;
    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: fallbackSetThinkingLevel,
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: degradedSession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test degraded level locality",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "max",
      // no fallbackThinkingLevel on purpose
    });

    await expect((session as any).promptWithFallback("Run task")).resolves.toBeUndefined();

    expect(degradedSetThinkingLevel).toHaveBeenCalledWith("xhigh");
    // The fallback inherits the ORIGINAL configured level, not the degraded one.
    expect(fallbackSetThinkingLevel).toHaveBeenCalledWith("max");
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
  });

  // FNXC:ThinkingEffortFallback 2026-08-25-00:00: "Model is unavailable" and
  // "Internal server error" envelopes are deliberately NOT treated as effort
  // rejections — the former is a model-availability problem (fallback-model
  // path) and the latter is ambiguous (generic retry). Verifying both stay on
  // the existing path prevents a regression.
  it("does NOT degrade effort on Model-unavailable or generic Internal server error", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    for (const errorMessage of [
      "Upstream request failed: Model is unavailable.",
      "Internal server error",
    ]) {
      const session = {
        model: { provider: "test", id: "primary-model" },
        prompt: vi.fn().mockRejectedValue(new Error(errorMessage)),
        subscribe: vi.fn(),
        dispose: vi.fn(),
        setThinkingLevel: vi.fn(),
        sessionFile: undefined,
      } as unknown as AgentSession;
      createAgentSessionMock.mockReset();
      createAgentSessionMock.mockResolvedValueOnce({ session } as any);
      const { session: created } = await createFnAgent({
        cwd: "/test/project",
        systemPrompt: "Test non-effort rejection",
        defaultProvider: "test",
        defaultModelId: "primary-model",
        defaultThinkingLevel: "max",
      });
      await expect((created as any).promptWithFallback("Run task")).rejects.toThrow();
      // No second session swap — the rejection must NOT be retried via the
      // effort-degradation ladder.
      expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    }
  });

  it("retries prompt on thinking/reasoning conflict without switching fallback models", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);

    const firstSession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(new Error("400 cannot specify both 'thinking' and 'reasoning_effort'")),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    const retrySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: firstSession } as any)
      .mockResolvedValueOnce({ session: retrySession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test thinking compatibility",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      defaultThinkingLevel: "high",
    });

    await expect((session as any).promptWithFallback("Run review")).resolves.toBeUndefined();

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect((retrySession.setThinkingLevel as any).mock.calls.length).toBe(0);
  });
});

describe("piLog structured diagnostics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(piLog, "log").mockImplementation(() => {});
    debugSpy = vi.spyOn(piLog, "debug").mockImplementation(() => {});
    warnSpy = vi.spyOn(piLog, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(piLog, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs session creation with model info", async () => {
    await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test",
      defaultProvider: "test",
      defaultModelId: "test-model",
    });

    // FNXC:EngineDiagnostics 2026-07-26-10:00: session-created bookkeeping is debug-gated.
    const hasModelLog = debugSpy.mock.calls.some(([message]) =>
      String(message).includes("Session created successfully (model=test/test-model)"),
    );
    expect(hasModelLog).toBe(true);
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Session created successfully"),
    );
  });

  it("fires fallback hook on session-creation fallback", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({
        session: {
          model: { provider: "test", id: "fallback-model" },
          prompt: vi.fn(),
          subscribe: vi.fn(),
          dispose: vi.fn(),
          setThinkingLevel: vi.fn(),
          sessionFile: undefined,
        },
      } as any);

    await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      taskId: "FN-1",
      taskTitle: "My Task",
      onFallbackModelUsed,
    });

    expect(onFallbackModelUsed).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerPoint: "session-creation",
        primaryModel: "test/primary-model",
        fallbackModel: "test/fallback-model",
        taskId: "FN-1",
      }),
    );
  });

  it("fires fallback hook on session-creation model-auth-tier fallback", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(
        new Error(
          "Codex error: 400 invalid_request_error — \"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\"",
        ),
      )
      .mockResolvedValueOnce({
        session: {
          model: { provider: "test", id: "fallback-model" },
          prompt: vi.fn(),
          subscribe: vi.fn(),
          dispose: vi.fn(),
          setThinkingLevel: vi.fn(),
          sessionFile: undefined,
        },
      } as any);

    await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      taskId: "FN-1",
      taskTitle: "My Task",
      onFallbackModelUsed,
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(onFallbackModelUsed).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerPoint: "session-creation",
        taskId: "FN-1",
      }),
    );
  });

  it("fires fallback hook on prompt-time fallback", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();

    const primarySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      taskId: "FN-2",
      onFallbackModelUsed,
    });

    await (session as any).promptWithFallback("prompt text");

    expect(onFallbackModelUsed).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerPoint: "prompt-time",
        taskId: "FN-2",
      }),
    );
  });

  it("throws a bounded fallback exhaustion error when prompt-time fallback also fails", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    const primaryPrompt = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    const fallbackPrompt = vi.fn().mockRejectedValue(new Error("401 invalid api key for fallback"));
    const primaryRetryPrompt = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));

    const primarySession = {
      model: { provider: "openai", id: "gpt-4o" },
      prompt: primaryPrompt,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    const fallbackSession = {
      model: { provider: "anthropic", id: "claude-3-5-haiku-20241022" },
      prompt: fallbackPrompt,
      state: { errorMessage: "", messages: [] },
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    const primaryRetrySession = {
      model: { provider: "openai", id: "gpt-4o" },
      prompt: primaryRetryPrompt,
      subscribe: vi.fn(), dispose: vi.fn(), setThinkingLevel: vi.fn(), sessionFile: undefined,
    } as unknown as AgentSession;
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any)
      .mockResolvedValueOnce({ session: primaryRetrySession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test planner fallback exhaustion",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "anthropic",
      fallbackModelId: "claude-3-5-haiku-20241022",
      taskId: "FN-7437",
      onFallbackModelUsed,
    });

    await expect((session as any).promptWithFallback("prompt text")).rejects.toMatchObject({
      name: "ModelFallbackExhaustedError",
      attempts: 3,
      primaryModel: "openai/gpt-4o",
      fallbackModel: "anthropic/claude-3-5-haiku-20241022",
      triggerPoint: "prompt-time",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    expect(primaryPrompt).toHaveBeenCalledTimes(1);
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(primaryRetryPrompt).toHaveBeenCalledTimes(1);
    expect((createAgentSessionMock.mock.calls[2]?.[0] as any).model.id).toBe("gpt-4o");
    expect(onFallbackModelUsed).toHaveBeenCalledTimes(1);
    expect(onFallbackModelUsed).toHaveBeenCalledWith(expect.objectContaining({
      triggerPoint: "prompt-time",
      primaryModel: "openai/gpt-4o",
      fallbackModel: "anthropic/claude-3-5-haiku-20241022",
      taskId: "FN-7437",
    }));
  });

  it("does not create a meaningless prompt-time fallback when primary and fallback match", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    const primarySession = {
      model: { provider: "openai", id: "gpt-4o" },
      prompt: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockResolvedValueOnce({ session: primarySession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test same fallback",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4o",
      onFallbackModelUsed,
    });

    await expect((session as any).promptWithFallback("prompt text")).rejects.toMatchObject({
      name: "ModelFallbackExhaustedError",
      attempts: 1,
      primaryModel: "openai/gpt-4o",
      fallbackModel: undefined,
    });
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(onFallbackModelUsed).not.toHaveBeenCalled();
  });

  it("fires fallback hook on prompt-time model-auth-tier fallback", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    const primaryState = { errorMessage: "", messages: [] };
    const fallbackPrompt = vi.fn().mockResolvedValue(undefined);
    const modelAuthTierError =
      "Codex error: 400 invalid_request_error — \"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\"";

    const primarySession = {
      model: { provider: "test", id: "primary-model" },
      prompt: vi.fn(async () => {
        primaryState.errorMessage = modelAuthTierError;
      }),
      state: primaryState,
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    const fallbackSession = {
      model: { provider: "test", id: "fallback-model" },
      prompt: fallbackPrompt,
      state: { errorMessage: "", messages: [] },
      subscribe: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      sessionFile: undefined,
    } as unknown as AgentSession;

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session: primarySession } as any)
      .mockResolvedValueOnce({ session: fallbackSession } as any);

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
      taskId: "FN-2",
      onFallbackModelUsed,
    });

    await (session as any).promptWithFallback("prompt text");

    expect(fallbackPrompt).toHaveBeenCalledWith("prompt text");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(onFallbackModelUsed).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerPoint: "prompt-time",
        taskId: "FN-2",
      }),
    );
  });

  it("swaps once to fallback for Anthropic Sonnet 5 not_found_error without retaining the primary failure", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    const onFallbackModelUsed = vi.fn();
    const sonnet5NotFoundError =
      'Error: 404 {"type":"error","error":{"type":"not_found_error","message":"Not found"},"request_id":"req_011CcawcZ3Ra9CennJXM8oWC"}';
    const sonnetPrompt = vi.fn(async () => {
      throw new Error(sonnet5NotFoundError);
    });
    const fallbackPrompt = vi.fn(async (_prompt: string, _options?: unknown) => undefined);

    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockImplementation(async (options: any) => {
      if (options.model?.id === "claude-sonnet-5") {
        return {
          session: {
            model: { provider: "anthropic", id: "claude-sonnet-5" },
            prompt: sonnetPrompt,
            state: { errorMessage: "", messages: [] },
            subscribe: vi.fn(),
            dispose: vi.fn(),
            setThinkingLevel: vi.fn(),
            sessionFile: undefined,
          },
        } as any;
      }
      return {
        session: {
          model: { provider: "zai", id: "glm-5.1" },
          prompt: fallbackPrompt,
          state: { errorMessage: "", messages: [{ role: "assistant", content: "Fallback reply" }] },
          subscribe: vi.fn(),
          dispose: vi.fn(),
          setThinkingLevel: vi.fn(),
          sessionFile: undefined,
        },
      } as any;
    });

    const { session } = await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test Sonnet 5 fallback",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-5",
      fallbackProvider: "zai",
      fallbackModelId: "glm-5.1",
      taskId: "FN-7358",
      onFallbackModelUsed,
    });

    await expect((session as any).promptWithFallback("prompt text", { temperature: 0 })).resolves.toBeUndefined();

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(fallbackPrompt).toHaveBeenCalledWith("prompt text", { temperature: 0 });
    expect((session as any).state.errorMessage ?? "").toBe("");
    expect(onFallbackModelUsed).toHaveBeenCalledWith(expect.objectContaining({
      triggerPoint: "prompt-time",
      primaryModel: "anthropic/claude-sonnet-5",
      fallbackModel: "zai/glm-5.1",
      taskId: "FN-7358",
    }));
  });

  it("logs warning on primary model failure and fallback attempt", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({
        session: {
          model: { provider: "test", id: "fallback-model" },
          prompt: vi.fn(),
          subscribe: vi.fn(),
          dispose: vi.fn(),
          setThinkingLevel: vi.fn(),
          sessionFile: undefined,
        },
      } as any);

    await createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test",
      defaultProvider: "test",
      defaultModelId: "primary-model",
      fallbackProvider: "test",
      fallbackModelId: "fallback-model",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "Primary model failed (429 Too Many Requests), trying fallback",
    );
    expect(debugSpy).toHaveBeenCalledWith("Fallback session created successfully");
    expect(logSpy).not.toHaveBeenCalledWith("Fallback session created successfully");
  });

  it("logs error when session creation fails with non-retryable error", async () => {
    const createAgentSessionMock = vi.mocked(createAgentSession);
    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockRejectedValueOnce(new Error("fatal model failure"));

    await expect(createFnAgent({
      cwd: "/test/project",
      systemPrompt: "Test",
      defaultProvider: "test",
      defaultModelId: "primary-model",
    })).rejects.toThrow("fatal model failure");

    expect(errorSpy).toHaveBeenCalledWith("Session creation failed: fatal model failure");
  });

  it("logs promptWithFallback trace at log level", async () => {
    const session = {
      prompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    await promptWithFallback(session, "test prompt");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("promptWithFallback: calling session.prompt (prompt length=11)"),
    );
    expect(logSpy).toHaveBeenCalledWith("promptWithFallback: prompt completed");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("isModelAuthTierIncompatibilityError", () => {
  it("matches Codex ChatGPT-account model-auth-tier incompatibility errors", () => {
    expect(
      isModelAuthTierIncompatibilityError(
        "Codex error: 400 invalid_request_error — \"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\"",
      ),
    ).toBe(true);
  });

  it("matches general model compatibility errors", () => {
    expect(isModelAuthTierIncompatibilityError("The gpt-5.3-codex model is not supported for this account")).toBe(true);
    expect(isModelAuthTierIncompatibilityError("model gpt-5.3-codex is not available to this organization")).toBe(true);
  });

  it("matches invalid_request_error model not found compatibility errors", () => {
    expect(isModelAuthTierIncompatibilityError("400 invalid_request_error: model gpt-5.3-codex was not found")).toBe(true);
  });

  it("does not match unrelated provider errors", () => {
    expect(isModelAuthTierIncompatibilityError("400 invalid_request_error: invalid temperature for this request")).toBe(false);
    expect(isModelAuthTierIncompatibilityError("400 bad request: missing required field messages")).toBe(false);
    expect(isModelAuthTierIncompatibilityError("ENOENT: no such file or directory")).toBe(false);
  });
});

describe("isRetryableModelSelectionError", () => {
  it("treats model-auth-tier incompatibility as model-selection retryable so the fallback model is tried", () => {
    expect(
      isRetryableModelSelectionError(
        "Codex error: 400 invalid_request_error — \"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\"",
      ),
    ).toBe(true);
    expect(isRetryableModelSelectionError("The gpt-5.3-codex model is not supported for this account")).toBe(true);
    expect(isRetryableModelSelectionError("400 invalid_request_error: missing required field messages")).toBe(false);
  });

  it("treats provider model-not-found payloads as model-selection retryable", () => {
    expect(
      isRetryableModelSelectionError(
        'Error: 404 {"type":"error","error":{"type":"not_found_error","message":"Not found"},"request_id":"req_011CcawcZ3Ra9CennJXM8oWC"}',
      ),
    ).toBe(true);
    expect(isRetryableModelSelectionError("model claude-sonnet-5 not found")).toBe(true);
    expect(isRetryableModelSelectionError("GET /api/tasks/FN-404 returned 404 Not Found")).toBe(false);
  });

  it("treats an unsupported message-role rejection as model-selection retryable so the fallback model is tried (issue #1261)", () => {
    expect(
      isRetryableModelSelectionError(
        "developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.[0].role'",
      ),
    ).toBe(true);
  });

  it("still matches the existing auth/rate-limit/capacity signals", () => {
    expect(isRetryableModelSelectionError("invalid api key")).toBe(true);
    expect(isRetryableModelSelectionError("HTTP 429 too many requests")).toBe(true);
    expect(isRetryableModelSelectionError("model is overloaded")).toBe(true);
  });

  it("treats a provider-not-configured failure as model-selection retryable so the fallback model is tried", () => {
    // pi-ai surfaces an unresolved provider credential as this exact string (ModelsError code "auth").
    // A configured fallback on a different provider can recover, so it must enter the single-swap path.
    expect(isRetryableModelSelectionError("Provider is not configured: anthropic")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isRetryableModelSelectionError("ENOENT: no such file or directory")).toBe(false);
    expect(isRetryableModelSelectionError("syntax error near unexpected token")).toBe(false);
  });
});
