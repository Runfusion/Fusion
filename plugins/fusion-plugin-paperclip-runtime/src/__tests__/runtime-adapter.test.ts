/**
 * Runtime Adapter Tests
 *
 * Tests for the PaperclipRuntimeAdapter class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PaperclipRuntimeAdapter } from "../runtime-adapter.js";

// ── Mock Modules ────────────────────────────────────────────────────────────────

const mockCreateFnAgent = vi.fn();
const mockPromptWithFallback = vi.fn();

vi.mock("../../../../packages/engine/src/pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: vi.fn().mockReturnValue("mock/anthropic-claude"),
}));

// ── Test Suite ─────────────────────────────────────────────────────────────────

describe("PaperclipRuntimeAdapter", () => {
  let adapter: PaperclipRuntimeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new PaperclipRuntimeAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runtime identity", () => {
    it("should have id 'paperclip'", () => {
      expect(adapter.id).toBe("paperclip");
    });

    it("should have name 'Paperclip Runtime'", () => {
      expect(adapter.name).toBe("Paperclip Runtime");
    });
  });

  describe("createSession", () => {
    it("should call createFnAgent with correct options", async () => {
      const mockSession = { dispose: vi.fn() };
      const mockResult = { session: mockSession, sessionFile: "/path/to/session.json" };
      mockCreateFnAgent.mockResolvedValue(mockResult);

      const options = {
        cwd: "/project",
        systemPrompt: "You are helpful",
        skills: ["bash", "read"],
      };

      const result = await adapter.createSession(options);

      expect(mockCreateFnAgent).toHaveBeenCalledTimes(1);
      expect(mockCreateFnAgent).toHaveBeenCalledWith({
        cwd: "/project",
        systemPrompt: "You are helpful",
        tools: undefined,
        customTools: undefined,
        onText: undefined,
        onThinking: undefined,
        onToolStart: undefined,
        onToolEnd: undefined,
        defaultProvider: undefined,
        defaultModelId: undefined,
        fallbackProvider: undefined,
        fallbackModelId: undefined,
        defaultThinkingLevel: undefined,
        sessionManager: undefined,
        skillSelection: undefined,
        skills: ["bash", "read"],
      });
      expect(result.session).toBe(mockSession);
      expect(result.sessionFile).toBe("/path/to/session.json");
    });

    it("should pass through model options", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        fallbackProvider: "openai",
        fallbackModelId: "gpt-4o",
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "anthropic",
          defaultModelId: "claude-sonnet-4-5",
          fallbackProvider: "openai",
          fallbackModelId: "gpt-4o",
        }),
      );
    });

    it("should pass through custom tools", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });
      const customTools = [{ name: "custom_tool", execute: vi.fn() }];

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        customTools,
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          customTools,
        }),
      );
    });

    it("should pass through skill selection context", async () => {
      mockCreateFnAgent.mockResolvedValue({ session: {} });
      const skillSelection = {
        projectRootDir: "/project",
        requestedSkillNames: ["bash"],
        sessionPurpose: "executor" as const,
      };

      await adapter.createSession({
        cwd: "/project",
        systemPrompt: "Test",
        skillSelection,
      });

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          skillSelection,
        }),
      );
    });
  });

  describe("promptWithFallback", () => {
    it("should delegate to promptWithFallback from engine", async () => {
      const mockSession = { id: "test-session" };
      mockPromptWithFallback.mockResolvedValue(undefined);

      await adapter.promptWithFallback(mockSession as any, "Hello", { images: [] });

      expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
      expect(mockPromptWithFallback).toHaveBeenCalledWith(mockSession, "Hello", { images: [] });
    });

    it("should work without options", async () => {
      mockPromptWithFallback.mockResolvedValue(undefined);

      await adapter.promptWithFallback({} as any, "Hello");

      expect(mockPromptWithFallback).toHaveBeenCalledWith({}, "Hello", undefined);
    });
  });

  describe("describeModel", () => {
    it("should return model description from pi describeModel", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { describeModel } = require("../../../../packages/engine/src/pi.js");

      const mockSession = { model: { provider: "anthropic", id: "claude-sonnet-4-5" } };
      const result = adapter.describeModel(mockSession as any);

      expect(describeModel).toHaveBeenCalledWith(mockSession);
      expect(result).toBe("mock/anthropic-claude"); // from mock
    });
  });

  describe("dispose", () => {
    it("should call session.dispose() when available", async () => {
      const disposeMock = vi.fn().mockResolvedValue(undefined);
      const mockSession = { dispose: disposeMock } as any;

      await adapter.dispose(mockSession);

      expect(disposeMock).toHaveBeenCalledTimes(1);
    });

    it("should be a no-op when session has no dispose method", async () => {
      const mockSession = { id: "test" } as any;

      // Should not throw
      await expect(adapter.dispose(mockSession)).resolves.toBeUndefined();
    });

    it("should handle dispose that throws", async () => {
      const disposeMock = vi.fn().mockRejectedValue(new Error("Dispose failed"));
      const mockSession = { dispose: disposeMock } as any;

      await expect(adapter.dispose(mockSession)).rejects.toThrow("Dispose failed");
    });
  });
});
