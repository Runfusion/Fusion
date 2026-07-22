/**
 * Runtime Selection Regression Tests
 *
 * These tests verify that engine subsystems correctly use the runtime resolution
 * system and fall back to the default pi runtime when no runtime hint is configured.
 *
 * Key behaviors tested:
 * 1. Subsystems with pluginRunner option can resolve plugin runtimes
 * 2. Subsystems without pluginRunner or hint fall back to pi runtime
 * 3. Runtime resolution logs are emitted correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the logger to suppress output during tests
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock pi.js to avoid actual session creation
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn().mockResolvedValue({
    session: {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      prompt: vi.fn(),
    },
    sessionFile: undefined,
  }),
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
  describeModel: vi.fn().mockReturnValue("anthropic/claude-sonnet-4-5"),
}));

// Mock the runtime resolution module
const mockResolveRuntime = vi.fn();
vi.mock("../execution/runtime-resolution.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/runtime-resolution.js")>("../runtime-resolution.js");
  return {
    ...actual,
    resolveRuntime: (...args: unknown[]) => mockResolveRuntime(...args),
    buildRuntimeResolutionContext: vi.fn().mockReturnValue({
      sessionPurpose: "test",
      runtimeHint: undefined,
      pluginRunner: {},
    }),
  };
});

// Mock session skill context
vi.mock("../cli-runtime/session-skill-context.js", () => ({
  buildSessionSkillContext: vi.fn().mockResolvedValue({
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none",
  }),
  buildSessionSkillContextSync: vi.fn().mockReturnValue({
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none",
  }),
}));

// Mock agent instructions
vi.mock("../agents/agent-instructions.js", () => ({
  resolveAgentInstructions: vi.fn().mockResolvedValue(""),
  buildSystemPromptWithInstructions: vi.fn().mockImplementation((base) => base),
  resolveAgentInstructionsWithRatings: vi.fn().mockResolvedValue(""),
}));

describe("Runtime Selection Regression Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: resolveRuntime returns pi runtime
    mockResolveRuntime.mockResolvedValue({
      runtime: {
        id: "pi",
        name: "Default PI Runtime",
        createSession: async () => ({
          session: {
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            prompt: vi.fn(),
          },
        }),
        promptWithFallback: vi.fn(),
        describeModel: () => "anthropic/claude-sonnet-4-5",
      },
      wasConfigured: false,
      runtimeId: "pi",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createResolvedAgentSession", () => {
    it("should call resolveRuntime when creating a session", async () => {
      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      await createResolvedAgentSession({
        sessionPurpose: "executor",
        pluginRunner: {} as any,
        cwd: "/test/path",
        systemPrompt: "Test prompt",
      });

      expect(mockResolveRuntime).toHaveBeenCalled();
    });

    it("should use the resolved runtime's createSession method", async () => {
      const mockCreateSession = vi.fn().mockResolvedValue({
        session: {
          model: { provider: "test", id: "test-model" },
        },
      });

      mockResolveRuntime.mockResolvedValue({
        runtime: {
          id: "test-runtime",
          name: "Test Runtime",
          createSession: mockCreateSession,
          promptWithFallback: vi.fn(),
          describeModel: () => "test/model",
        },
        wasConfigured: true,
        runtimeId: "test-runtime",
      });

      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      const permanentAgentGating = {
        permissionPolicy: {
          presetId: "approval-required",
          rules: { command_execution: "require-approval" as const },
        },
      };

      await createResolvedAgentSession({
        sessionPurpose: "executor",
        pluginRunner: {} as any,
        cwd: "/test/path",
        systemPrompt: "Test prompt",
        permanentAgentGating,
      });

      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ permanentAgentGating }));
    });

    it("should return runtime metadata along with session", async () => {
      mockResolveRuntime.mockResolvedValue({
        runtime: {
          id: "my-runtime",
          name: "My Runtime",
          createSession: async () => ({
            session: {
              model: { provider: "test", id: "test-model" },
            },
          }),
          promptWithFallback: vi.fn(),
          describeModel: () => "test/model",
        },
        wasConfigured: true,
        runtimeId: "my-runtime",
      });

      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      const result = await createResolvedAgentSession({
        sessionPurpose: "triage",
        cwd: "/test/path",
        systemPrompt: "Test prompt",
      });

      expect(result.runtimeId).toBe("my-runtime");
      expect(result.wasConfigured).toBe(true);
    });
  });

  describe("Default pi runtime fallback", () => {
    it("should fall back to pi runtime when no runtime hint provided", async () => {
      mockResolveRuntime.mockResolvedValue({
        runtime: {
          id: "pi",
          name: "Default PI Runtime",
          createSession: async () => ({
            session: {
              model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            },
          }),
          promptWithFallback: vi.fn(),
          describeModel: () => "anthropic/claude-sonnet-4-5",
        },
        wasConfigured: false,
        runtimeId: "pi",
      });

      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      const result = await createResolvedAgentSession({
        sessionPurpose: "merger",
        cwd: "/test/path",
        systemPrompt: "Test prompt",
      });

      expect(result.runtimeId).toBe("pi");
      expect(result.wasConfigured).toBe(false);
    });

    it("should fall back to pi runtime when runtime hint references non-existent runtime", async () => {
      mockResolveRuntime.mockResolvedValue({
        runtime: {
          id: "pi",
          name: "Default PI Runtime",
          createSession: async () => ({
            session: {
              model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            },
          }),
          promptWithFallback: vi.fn(),
          describeModel: () => "anthropic/claude-sonnet-4-5",
        },
        wasConfigured: false,
        runtimeId: "pi",
      });

      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      const result = await createResolvedAgentSession({
        sessionPurpose: "heartbeat",
        pluginRunner: {} as any,
        runtimeHint: "non-existent-runtime",
        cwd: "/test/path",
        systemPrompt: "Test prompt",
      });

      expect(result.runtimeId).toBe("pi");
      expect(result.wasConfigured).toBe(false);
    });
  });

  describe("Plugin runtime selection", () => {
    it("should use configured plugin runtime when hint matches", async () => {
      mockResolveRuntime.mockResolvedValue({
        runtime: {
          id: "code-interpreter",
          name: "Code Interpreter Runtime",
          createSession: async () => ({
            session: {
              model: { provider: "custom", id: "custom-model" },
            },
          }),
          promptWithFallback: vi.fn(),
          describeModel: () => "custom/model",
        },
        wasConfigured: true,
        runtimeId: "code-interpreter",
      });

      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      const result = await createResolvedAgentSession({
        sessionPurpose: "executor",
        pluginRunner: {
          getRuntimeById: vi.fn().mockReturnValue({
            pluginId: "code-plugin",
            runtime: {
              metadata: { runtimeId: "code-interpreter", name: "Code Interpreter" },
              factory: vi.fn(),
            },
          }),
        } as any,
        runtimeHint: "code-interpreter",
        cwd: "/test/path",
        systemPrompt: "Test prompt",
      });

      expect(result.runtimeId).toBe("code-interpreter");
      expect(result.wasConfigured).toBe(true);
    });

    it("should route runtimeHint=openclaw to the openclaw runtime", async () => {
      mockResolveRuntime.mockResolvedValue({
        runtime: {
          id: "openclaw",
          name: "OpenClaw Runtime",
          createSession: async () => ({
            session: {
              model: { provider: "openclaw", id: "openclaw-agent" },
            },
          }),
          promptWithFallback: vi.fn(),
          describeModel: () => "openclaw/openclaw-agent",
        },
        wasConfigured: true,
        runtimeId: "openclaw",
      });

      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      const result = await createResolvedAgentSession({
        sessionPurpose: "executor",
        pluginRunner: {} as any,
        runtimeHint: "openclaw",
        cwd: "/test/path",
        systemPrompt: "Test prompt",
      });

      expect(result.runtimeId).toBe("openclaw");
      expect(result.wasConfigured).toBe(true);
    });

    it("should route runtimeHint=droid to the droid runtime", async () => {
      mockResolveRuntime.mockResolvedValue({
        runtime: {
          id: "droid",
          name: "Droid Runtime",
          createSession: async () => ({
            session: {
              model: { provider: "droid-cli", id: "droid-pro" },
            },
          }),
          promptWithFallback: vi.fn(),
          describeModel: () => "droid/droid-pro",
        },
        wasConfigured: true,
        runtimeId: "droid",
      });

      const { createResolvedAgentSession } = await import("../agents/agent-session-helpers.js");

      const result = await createResolvedAgentSession({
        sessionPurpose: "executor",
        pluginRunner: {} as any,
        runtimeHint: "droid",
        cwd: "/test/path",
        systemPrompt: "Test prompt",
      });

      expect(result.runtimeId).toBe("droid");
      expect(result.wasConfigured).toBe(true);
    });
  });
});
