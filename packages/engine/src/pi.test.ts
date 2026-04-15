import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeModel, compactSessionContext, COMPACTION_FALLBACK_INSTRUCTIONS, createKbAgent, promptWithFallback, type AgentOptions } from "./pi.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

// Mock skill resolver functions - define inside factory to avoid hoisting issues
vi.mock("./skill-resolver.js", () => {
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
vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
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
  createExtensionRuntime: vi.fn(),
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    skillsOverride: undefined,
  })),
  DefaultPackageManager: vi.fn(),
  discoverAndLoadExtensions: vi.fn().mockResolvedValue({ errors: [], runtime: { pendingProviderRegistrations: [] } }),
  getAgentDir: vi.fn(() => "/test/agent-dir"),
  ModelRegistry: vi.fn().mockImplementation(() => ({
    find: vi.fn().mockReturnValue({ provider: "test", id: "test-model" }),
    getAll: vi.fn().mockReturnValue([]),
    registerProvider: vi.fn(),
    refresh: vi.fn(),
  })),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

// Import mock accessors after mocking (must use dynamic import for hoisted mocks)
let resolveSessionSkillsMock: ReturnType<typeof vi.fn>;
let createSkillsOverrideFromSelectionMock: ReturnType<typeof vi.fn>;

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

describe("createKbAgent skills parameter", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let mockResolveSessionSkills: ReturnType<typeof vi.fn>;
  let mockCreateSkillsOverride: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    // Access the mocked module to get/set mocks
    const skillResolver = await import("./skill-resolver.js");
    mockResolveSessionSkills = vi.mocked(skillResolver.resolveSessionSkills);
    mockCreateSkillsOverride = vi.mocked(skillResolver.createSkillsOverrideFromSelection);
    
    mockResolveSessionSkills.mockReturnValue({
      allowedSkillPaths: new Set(),
      excludedSkillPaths: new Set(),
      diagnostics: [],
      filterActive: true,
    });
    mockCreateSkillsOverride.mockReturnValue(() => ({
      skills: [],
      diagnostics: [],
    }));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("skills parameter auto-derives SkillSelectionContext", async () => {
    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: ["review", "fusion"],
    };

    await createKbAgent(options);

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

    await createKbAgent(options);

    // Verify resolveSessionSkills was called with explicit skillSelection (not auto-derived)
    expect(mockResolveSessionSkills).toHaveBeenCalledTimes(1);
    const callArgs = mockResolveSessionSkills.mock.calls[0]![0];
    expect(callArgs.projectRootDir).toBe("/other");
    expect(callArgs.requestedSkillNames).toEqual(["triage"]);
    expect(callArgs.sessionPurpose).toBe("triage");

    // Verify the convenience log was NOT emitted (skillSelection takes precedence)
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Using skills from convenience parameter")
    );
  });

  it("empty skills array is treated as unset", async () => {
    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: [],
    };

    await createKbAgent(options);

    // Verify no skill resolution occurred
    expect(mockResolveSessionSkills).not.toHaveBeenCalled();
    expect(mockCreateSkillsOverride).not.toHaveBeenCalled();
  });

  it("skills auto-derivation logs the convenience parameter", async () => {
    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: ["review", "fusion"],
    };

    await createKbAgent(options);

    // Verify the log message includes the skill names
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[pi] Using skills from convenience parameter: [review, fusion]")
    );
  });

  it("skills without corresponding discovered skills produces diagnostics", async () => {
    // Mock to return diagnostics for missing skill
    mockResolveSessionSkills.mockReturnValue({
      allowedSkillPaths: new Set(),
      excludedSkillPaths: new Set(),
      diagnostics: [
        { type: "warning" as const, message: 'Requested skill "nonexistent-skill" not found in discovered skills' },
      ],
      filterActive: true,
    });

    const options: AgentOptions = {
      cwd: "/test/project",
      systemPrompt: "Test",
      skills: ["nonexistent-skill"],
    };

    await createKbAgent(options);

    // The diagnostics should be logged
    expect(mockResolveSessionSkills).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("warning")
    );
  });
});

describe("promptWithFallback auto-compaction", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
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

  it("delegates to session.promptWithFallback when available", async () => {
    // Mock session with promptWithFallback method
    const mockSessionPromptWithFallback = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn();
    const mockCompact = vi.fn();
    const session = {
      prompt: mockPrompt,
      compact: mockCompact,
      promptWithFallback: mockSessionPromptWithFallback,
    } as unknown as AgentSession;

    await promptWithFallback(session, "test prompt");

    // Verify session.promptWithFallback was called (auto-compaction handled by session)
    expect(mockSessionPromptWithFallback).toHaveBeenCalledTimes(1);
    // Verify direct prompt was NOT called
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
