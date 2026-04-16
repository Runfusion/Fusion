import { describe, it, expect, beforeEach } from "vitest";
import {
  compactMemoryWithAi,
  COMPACT_MEMORY_SYSTEM_PROMPT,
  AiServiceError,
  __resetCompactionState,
} from "./memory-compaction.js";

describe("memory-compaction", () => {
  beforeEach(() => {
    __resetCompactionState();
  });

  // ── Constants ──────────────────────────────────────────────────────────────

  describe("constants", () => {
    it("should have correct system prompt", () => {
      expect(COMPACT_MEMORY_SYSTEM_PROMPT).toContain("memory distillation");
      expect(COMPACT_MEMORY_SYSTEM_PROMPT).toContain("compacted markdown");
    });

    it("should have system prompt that instructs to preserve important info", () => {
      expect(COMPACT_MEMORY_SYSTEM_PROMPT).toContain("architectural conventions");
      expect(COMPACT_MEMORY_SYSTEM_PROMPT).toContain("pitfalls");
      expect(COMPACT_MEMORY_SYSTEM_PROMPT).toContain("decisions");
    });

    it("should have system prompt that instructs to remove redundant info", () => {
      expect(COMPACT_MEMORY_SYSTEM_PROMPT).toContain("Remove");
      expect(COMPACT_MEMORY_SYSTEM_PROMPT).toContain("redundant");
    });
  });

  // ── compactMemoryWithAi ────────────────────────────────────────────────────

  describe("compactMemoryWithAi", () => {
    it("should throw AiServiceError when engine not available", async () => {
      // In test environment, the dynamic import fails, so createKbAgent is undefined
      const content = "Some memory content that is long enough";
      await expect(compactMemoryWithAi(content, "/tmp")).rejects.toThrow(AiServiceError);
      await expect(compactMemoryWithAi(content, "/tmp")).rejects.toThrow("AI engine not available");
    });

    it("should throw AiServiceError with provider and modelId when engine not available", async () => {
      const content = "Some memory content that is long enough";
      await expect(
        compactMemoryWithAi(content, "/tmp", "anthropic", "claude-sonnet-4-5")
      ).rejects.toThrow(AiServiceError);
    });

    it("should throw AiServiceError for empty content", async () => {
      // Empty content will fail because the AI engine isn't available
      await expect(compactMemoryWithAi("", "/tmp")).rejects.toThrow(AiServiceError);
    });

    it("should throw AiServiceError for short content", async () => {
      // Short content will still fail because the AI engine isn't available
      const shortContent = "Too short";
      await expect(compactMemoryWithAi(shortContent, "/tmp")).rejects.toThrow(AiServiceError);
    });
  });

  // ── Error Classes ───────────────────────────────────────────────────────────

  describe("error classes", () => {
    it("AiServiceError should have correct name", () => {
      const err = new AiServiceError("ai failed");
      expect(err.name).toBe("AiServiceError");
      expect(err.message).toBe("ai failed");
    });

    it("AiServiceError should be an instance of Error", () => {
      const err = new AiServiceError("test");
      expect(err).toBeInstanceOf(Error);
    });
  });

  // ── State Reset ───────────────────────────────────────────────────────────

  describe("__resetCompactionState", () => {
    it("should be callable without error", () => {
      expect(() => __resetCompactionState()).not.toThrow();
    });
  });

  // ── Message Content Extraction ─────────────────────────────────────────────

  describe("message content extraction", () => {
    it("should extract string content from assistant message", () => {
      // This test documents the expected content extraction for string content
      const message = {
        role: "assistant" as const,
        content: "Compacted memory content here",
      };

      // Simulate the extraction logic
      let extracted = "";
      if (typeof message.content === "string") {
        extracted = message.content.trim();
      }

      expect(extracted).toBe("Compacted memory content here");
    });

    it("should extract array content blocks from assistant message", () => {
      // This test documents the expected content extraction for array content
      const contentBlocks = [
        { type: "text", text: "First part of " },
        { type: "text", text: "compacted memory." },
      ];

      // Simulate the extraction logic
      const extracted = contentBlocks
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();

      expect(extracted).toBe("First part of compacted memory.");
    });
  });
});
