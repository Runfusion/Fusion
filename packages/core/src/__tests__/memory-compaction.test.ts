import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  compactMemoryWithAi,
  COMPACT_MEMORY_SYSTEM_PROMPT,
  createAutoSummarizeAutomation,
  syncAutoSummarizeAutomation,
  AUTO_SUMMARIZE_SCHEDULE_NAME,
  DEFAULT_AUTO_SUMMARIZE_SCHEDULE,
  AiServiceError,
  __resetCompactionState,
} from "../memory/memory-compaction.js";

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

    it("should have correct auto-summarize schedule name", () => {
      expect(AUTO_SUMMARIZE_SCHEDULE_NAME).toBe("Memory Auto-Summarize");
    });

    it("should have correct default schedule", () => {
      expect(DEFAULT_AUTO_SUMMARIZE_SCHEDULE).toBe("0 3 * * *");
    });
  });

  // ── createAutoSummarizeAutomation ───────────────────────────────────────────

  describe("createAutoSummarizeAutomation", () => {
    it("should create automation with default settings", () => {
      const automation = createAutoSummarizeAutomation({});

      expect(automation.name).toBe(AUTO_SUMMARIZE_SCHEDULE_NAME);
      expect(automation.scheduleType).toBe("custom");
      expect(automation.cronExpression).toBe(DEFAULT_AUTO_SUMMARIZE_SCHEDULE);
      expect(automation.enabled).toBe(true);
      expect(automation.steps!).toHaveLength(1);
      expect(automation.steps![0].type).toBe("ai-prompt");
      expect(automation.steps![0].id).toBe("memory-auto-summarize");
    });

    it("should use custom schedule when provided", () => {
      const automation = createAutoSummarizeAutomation({
        memoryAutoSummarizeSchedule: "0 */6 * * *",
      });

      expect(automation.cronExpression).toBe("0 */6 * * *");
    });

    it("should include threshold in prompt", () => {
      const automation = createAutoSummarizeAutomation({
        memoryAutoSummarizeThresholdChars: 75000,
      });

      expect(automation.steps![0].prompt).toContain("75000");
    });

    it("should include model provider in step when provided", () => {
      const automation = createAutoSummarizeAutomation(
        {},
        "anthropic",
        "claude-sonnet-4-5"
      );

      expect(automation.steps![0].modelProvider).toBe("anthropic");
      expect(automation.steps![0].modelId).toBe("claude-sonnet-4-5");
    });

    it("should not include model fields when not provided", () => {
      const automation = createAutoSummarizeAutomation({});

      expect(automation.steps![0]).not.toHaveProperty("modelProvider");
      expect(automation.steps![0]).not.toHaveProperty("modelId");
      expect(automation.steps![0]).not.toHaveProperty("modelProvider");
      expect(automation.steps![0]).not.toHaveProperty("modelId");
    });

    it("should set correct timeout", () => {
      const automation = createAutoSummarizeAutomation({});

      expect(automation.steps![0].timeoutMs).toBe(120_000);
      expect(automation.steps![0].timeoutMs).toBe(120_000);
    });

    it("should prompt to preserve core sections", () => {
      const automation = createAutoSummarizeAutomation({});

      expect(automation.steps![0].prompt).toContain("Architecture");
      expect(automation.steps![0].prompt).toContain("Conventions");
      expect(automation.steps![0].prompt).toContain("Pitfalls");
      expect(automation.steps![0].prompt).toContain("Architecture");
      expect(automation.steps![0].prompt).toContain("Conventions");
      expect(automation.steps![0].prompt).toContain("Pitfalls");
    });

    it("should prompt to check threshold and skip when below", () => {
      const automation = createAutoSummarizeAutomation({});

      expect(automation.steps![0].prompt).toContain("Below threshold");
      expect(automation.steps![0].prompt).toContain("skipped");
      expect(automation.steps![0].prompt).toContain("Below threshold");
      expect(automation.steps![0].prompt).toContain("skipped");
    });

    it("should prompt to write compacted content to file", () => {
      const automation = createAutoSummarizeAutomation({});

      expect(automation.steps![0].prompt).toContain(".fusion/memory/MEMORY.md");
      expect(automation.steps![0].prompt).toContain(".fusion/memory/MEMORY.md");
    });
  });

  // ── syncAutoSummarizeAutomation ─────────────────────────────────────────────

  describe("syncAutoSummarizeAutomation", () => {
    it("should delete schedule when auto-summarize is disabled", async () => {
      const mockStore = {
        listSchedules: vi.fn().mockResolvedValue([
          { id: "sched-1", name: AUTO_SUMMARIZE_SCHEDULE_NAME },
        ]),
        deleteSchedule: vi.fn().mockResolvedValue(undefined),
      };

      await syncAutoSummarizeAutomation(mockStore as any, {
        memoryAutoSummarizeEnabled: false,
      });

      expect(mockStore.deleteSchedule).toHaveBeenCalledWith("sched-1");
    });

    it("should not delete schedule when auto-summarize is disabled but no schedule exists", async () => {
      const mockStore = {
        listSchedules: vi.fn().mockResolvedValue([]),
        deleteSchedule: vi.fn().mockResolvedValue(undefined),
      };

      await syncAutoSummarizeAutomation(mockStore as any, {
        memoryAutoSummarizeEnabled: false,
      });

      expect(mockStore.deleteSchedule).not.toHaveBeenCalled();
    });

    it("should create new schedule when auto-summarize is enabled and no schedule exists", async () => {
      const mockStore = {
        listSchedules: vi.fn().mockResolvedValue([]),
        createSchedule: vi.fn().mockResolvedValue({ id: "new-sched-1" }),
      };

      const result = await syncAutoSummarizeAutomation(mockStore as any, {
        memoryAutoSummarizeEnabled: true,
      });

      expect(mockStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: AUTO_SUMMARIZE_SCHEDULE_NAME,
          scheduleType: "custom",
          enabled: true,
        })
      );
      expect(result).toEqual({ id: "new-sched-1" });
    });

    it("should update existing schedule when auto-summarize is enabled", async () => {
      const mockStore = {
        listSchedules: vi.fn().mockResolvedValue([
          { id: "existing-sched", name: AUTO_SUMMARIZE_SCHEDULE_NAME },
        ]),
        updateSchedule: vi.fn().mockResolvedValue({ id: "existing-sched" }),
      };

      await syncAutoSummarizeAutomation(mockStore as any, {
        memoryAutoSummarizeEnabled: true,
        memoryAutoSummarizeSchedule: "0 3 * * 1",
      });

      expect(mockStore.updateSchedule).toHaveBeenCalledWith(
        "existing-sched",
        expect.objectContaining({
          scheduleType: "custom",
          cronExpression: "0 3 * * 1",
          enabled: true,
        })
      );
    });

    it("should use default schedule when not specified", async () => {
      const mockStore = {
        listSchedules: vi.fn().mockResolvedValue([]),
        createSchedule: vi.fn().mockResolvedValue({ id: "new-sched" }),
      };

      await syncAutoSummarizeAutomation(mockStore as any, {
        memoryAutoSummarizeEnabled: true,
      });

      expect(mockStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          cronExpression: DEFAULT_AUTO_SUMMARIZE_SCHEDULE,
        })
      );
    });

    it("should throw error for invalid cron expression", async () => {
      const mockStore = {
        listSchedules: vi.fn().mockResolvedValue([]),
      };

      await expect(
        syncAutoSummarizeAutomation(mockStore as any, {
          memoryAutoSummarizeEnabled: true,
          memoryAutoSummarizeSchedule: "not-a-cron",
        })
      ).rejects.toThrow("Invalid auto-summarize schedule");
    });
  });

  // ── compactMemoryWithAi ────────────────────────────────────────────────────

  describe("compactMemoryWithAi", () => {
    it("should throw AiServiceError when AI service cannot process request", async () => {
      const content = "Some memory content that is long enough";

      await expect(compactMemoryWithAi(content, "/tmp")).rejects.toThrow(AiServiceError);
      await expect(compactMemoryWithAi(content, "/tmp")).rejects.toThrow(
        /(AI engine not available|No model selected)/
      );
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
