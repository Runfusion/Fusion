import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import {
  MEMORY_WORKING_PATH,
  MEMORY_INSIGHTS_PATH,
  DEFAULT_INSIGHT_SCHEDULE,
  DEFAULT_MIN_INTERVAL_MS,
  MIN_INSIGHT_GROWTH_CHARS,
  INSIGHT_EXTRACTION_SCHEDULE_NAME,
  readWorkingMemory,
  readInsightsMemory,
  writeInsightsMemory,
  buildInsightExtractionPrompt,
  parseInsightExtractionResponse,
  mergeInsights,
  shouldTriggerExtraction,
  getDefaultInsightsTemplate,
  createInsightExtractionAutomation,
} from "./memory-insights.js";
import type { MemoryInsight, InsightExtractionResult } from "./memory-insights.js";
import type { ProjectSettings } from "./types.js";

describe("memory-insights", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-memory-insights-test-"));
    await mkdir(join(tempDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── readWorkingMemory ────────────────────────────────────────────────

  describe("readWorkingMemory", () => {
    it("should return content when memory.md exists", async () => {
      const content = "# Working Memory\n\nSome observations";
      writeFileSync(join(tempDir, MEMORY_WORKING_PATH), content);

      const result = await readWorkingMemory(tempDir);
      expect(result).toBe(content);
    });

    it("should return empty string when memory.md does not exist", async () => {
      const result = await readWorkingMemory(tempDir);
      expect(result).toBe("");
    });
  });

  // ── readInsightsMemory ───────────────────────────────────────────────

  describe("readInsightsMemory", () => {
    it("should return content when memory-insights.md exists", async () => {
      const content = "# Memory Insights\n\n## Patterns\n- Test pattern";
      writeFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), content);

      const result = await readInsightsMemory(tempDir);
      expect(result).toBe(content);
    });

    it("should return null when memory-insights.md does not exist", async () => {
      const result = await readInsightsMemory(tempDir);
      expect(result).toBeNull();
    });
  });

  // ── writeInsightsMemory ──────────────────────────────────────────────

  describe("writeInsightsMemory", () => {
    it("should create the file with correct content", async () => {
      const content = "# Memory Insights\n\n## Patterns\n- New pattern";
      await writeInsightsMemory(tempDir, content);

      const filePath = join(tempDir, MEMORY_INSIGHTS_PATH);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe(content);
    });

    it("should overwrite existing content", async () => {
      writeFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), "old content");
      await writeInsightsMemory(tempDir, "new content");

      expect(readFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), "utf-8")).toBe("new content");
    });

    it("should create .fusion directory if it does not exist", async () => {
      const newDir = join(tempDir, "new-project");
      await mkdir(newDir, { recursive: true });
      // .fusion dir does not exist yet
      await writeInsightsMemory(newDir, "test content");
      expect(existsSync(join(newDir, MEMORY_INSIGHTS_PATH))).toBe(true);
    });
  });

  // ── buildInsightExtractionPrompt ─────────────────────────────────────

  describe("buildInsightExtractionPrompt", () => {
    it("should include working memory content", () => {
      const prompt = buildInsightExtractionPrompt("my working memory", null);
      expect(prompt).toContain("my working memory");
      expect(prompt).toContain("Working Memory");
    });

    it("should include existing insights when provided", () => {
      const prompt = buildInsightExtractionPrompt(
        "my working memory",
        "existing insights content",
      );
      expect(prompt).toContain("existing insights content");
      expect(prompt).toContain("Existing Insights");
    });

    it("should not include existing insights section when null", () => {
      const prompt = buildInsightExtractionPrompt("my working memory", null);
      expect(prompt).not.toContain("Existing Insights");
    });

    it("should include output format instructions", () => {
      const prompt = buildInsightExtractionPrompt("memory", null);
      expect(prompt).toContain("pattern");
      expect(prompt).toContain("principle");
      expect(prompt).toContain("convention");
      expect(prompt).toContain("pitfall");
      expect(prompt).toContain("context");
      expect(prompt).toContain("JSON");
    });
  });

  // ── parseInsightExtractionResponse ───────────────────────────────────

  describe("parseInsightExtractionResponse", () => {
    it("should parse valid JSON response", () => {
      const response = JSON.stringify({
        summary: "Found 2 insights",
        insights: [
          { category: "pattern", content: "Test pattern" },
          { category: "pitfall", content: "Avoid this", source: "Task FN-001" },
        ],
      });

      const result = parseInsightExtractionResponse(response);
      expect(result.summary).toBe("Found 2 insights");
      expect(result.insights).toHaveLength(2);
      expect(result.insights[0].category).toBe("pattern");
      expect(result.insights[0].content).toBe("Test pattern");
      expect(result.insights[1].category).toBe("pitfall");
      expect(result.insights[1].source).toBe("Task FN-001");
      expect(result.insights[0].extractedAt).toBeTruthy();
    });

    it("should parse JSON wrapped in markdown code fences", () => {
      const json = JSON.stringify({
        summary: "Test",
        insights: [{ category: "principle", content: "Keep it simple" }],
      });
      const response = "```json\n" + json + "\n```";

      const result = parseInsightExtractionResponse(response);
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0].content).toBe("Keep it simple");
    });

    it("should parse JSON with leading text before it", () => {
      const json = JSON.stringify({
        summary: "Test",
        insights: [{ category: "convention", content: "Use TypeScript" }],
      });
      const response = "Here are the insights:\n" + json + "\nDone.";

      const result = parseInsightExtractionResponse(response);
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0].content).toBe("Use TypeScript");
    });

    it("should handle empty insights array", () => {
      const response = JSON.stringify({
        summary: "No new insights found",
        insights: [],
      });

      const result = parseInsightExtractionResponse(response);
      expect(result.insights).toHaveLength(0);
      expect(result.summary).toBe("No new insights found");
    });

    it("should throw on invalid JSON", () => {
      expect(() => parseInsightExtractionResponse("not json at all")).toThrow(
        "Failed to parse insight extraction response",
      );
    });

    it("should handle missing summary gracefully", () => {
      const response = JSON.stringify({
        insights: [{ category: "pattern", content: "Something" }],
      });

      const result = parseInsightExtractionResponse(response);
      expect(result.summary).toBe("");
      expect(result.insights).toHaveLength(1);
    });

    it("should handle invalid category by defaulting to context", () => {
      const response = JSON.stringify({
        summary: "Test",
        insights: [{ category: "unknown-category", content: "Some insight" }],
      });

      const result = parseInsightExtractionResponse(response);
      expect(result.insights[0].category).toBe("context");
    });

    it("should skip insights with empty content", () => {
      const response = JSON.stringify({
        summary: "Test",
        insights: [
          { category: "pattern", content: "" },
          { category: "pattern", content: "Valid insight" },
          { category: "pattern", content: "   " },
        ],
      });

      const result = parseInsightExtractionResponse(response);
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0].content).toBe("Valid insight");
    });

    it("should handle non-array insights gracefully", () => {
      const response = JSON.stringify({
        summary: "Test",
        insights: "not an array",
      });

      const result = parseInsightExtractionResponse(response);
      expect(result.insights).toHaveLength(0);
    });
  });

  // ── mergeInsights ────────────────────────────────────────────────────

  describe("mergeInsights", () => {
    const baseInsights: MemoryInsight[] = [
      {
        category: "pattern",
        content: "Always use async/await",
        extractedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    it("should return default template when existing is empty and no new insights", () => {
      const result = mergeInsights("", []);
      expect(result).toContain("# Memory Insights");
      expect(result).toContain("## Patterns");
      expect(result).toContain("## Last Updated:");
    });

    it("should return existing unchanged when no new insights", () => {
      const existing = "# Memory Insights\n\n## Patterns\n- Old pattern\n";
      const result = mergeInsights(existing, []);
      expect(result).toBe(existing);
    });

    it("should use default template when existing is empty and new insights provided", () => {
      const result = mergeInsights("", baseInsights);
      expect(result).toContain("# Memory Insights");
      expect(result).toContain("Always use async/await");
    });

    it("should append new insights to the correct section", () => {
      const existing = getDefaultInsightsTemplate();
      const newInsights: MemoryInsight[] = [
        {
          category: "pattern",
          content: "New pattern discovered",
          extractedAt: "2026-04-04T00:00:00.000Z",
        },
        {
          category: "pitfall",
          content: "Avoid sync operations",
          extractedAt: "2026-04-04T00:00:00.000Z",
        },
      ];

      const result = mergeInsights(existing, newInsights);
      expect(result).toContain("New pattern discovered");
      expect(result).toContain("Avoid sync operations");

      // Pattern should be in the Patterns section
      const patternsIdx = result.indexOf("## Patterns");
      const principlesIdx = result.indexOf("## Principles");
      const patternEntryIdx = result.indexOf("New pattern discovered");
      expect(patternEntryIdx).toBeGreaterThan(patternsIdx);
      expect(patternEntryIdx).toBeLessThan(principlesIdx);

      // Pitfall should be in the Pitfalls section
      const pitfallsIdx = result.indexOf("## Pitfalls");
      const contextIdx = result.indexOf("## Context");
      const pitfallEntryIdx = result.indexOf("Avoid sync operations");
      expect(pitfallEntryIdx).toBeGreaterThan(pitfallsIdx);
      expect(pitfallEntryIdx).toBeLessThan(contextIdx);
    });

    it("should skip duplicate insights (case-insensitive)", () => {
      const existing = "# Memory Insights\n\n## Patterns\n- Always use async/await\n";
      const duplicates: MemoryInsight[] = [
        {
          category: "pattern",
          content: "ALWAYS USE ASYNC/AWAIT",
          extractedAt: "2026-04-04T00:00:00.000Z",
        },
      ];

      const result = mergeInsights(existing, duplicates);
      // Should not add the duplicate
      expect(result).toBe(existing);
    });

    it("should include source when provided", () => {
      const existing = getDefaultInsightsTemplate();
      const insights: MemoryInsight[] = [
        {
          category: "principle",
          content: "Test principle",
          source: "Task FN-924",
          extractedAt: "2026-04-04T00:00:00.000Z",
        },
      ];

      const result = mergeInsights(existing, insights);
      expect(result).toContain("Test principle");
      expect(result).toContain("source: Task FN-924");
    });

    it("should update the Last Updated timestamp", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-04T12:00:00.000Z"));

      const existing = "# Memory Insights\n\n## Last Updated: 2026-01-01\n";
      const result = mergeInsights(existing, baseInsights);
      expect(result).toContain("## Last Updated: 2026-04-04");

      vi.useRealTimers();
    });

    it("should create missing section when insight category section does not exist", () => {
      // Template without a Patterns section
      const existing = "# Memory Insights\n\n## Principles\n\n## Last Updated: 2026-01-01\n";
      const insights: MemoryInsight[] = [
        {
          category: "pattern",
          content: "New pattern for missing section",
          extractedAt: "2026-04-04T00:00:00.000Z",
        },
      ];

      const result = mergeInsights(existing, insights);
      expect(result).toContain("## Patterns");
      expect(result).toContain("New pattern for missing section");
    });
  });

  // ── shouldTriggerExtraction ──────────────────────────────────────────

  describe("shouldTriggerExtraction", () => {
    it("should return false when working memory is empty", () => {
      expect(shouldTriggerExtraction(undefined, {}, 0, undefined)).toBe(false);
    });

    it("should return true when never run and memory has content", () => {
      expect(shouldTriggerExtraction(undefined, {}, 500, undefined)).toBe(true);
    });

    it("should return true when enough time has passed and memory has grown", () => {
      const lastRun = new Date(Date.now() - DEFAULT_MIN_INTERVAL_MS - 1);
      expect(
        shouldTriggerExtraction(lastRun, {}, 5000, 1000),
      ).toBe(true);
    });

    it("should return false when not enough time has passed", () => {
      const lastRun = new Date(Date.now() - 1000); // 1 second ago
      expect(
        shouldTriggerExtraction(lastRun, {}, 5000, 1000),
      ).toBe(false);
    });

    it("should return false when time has passed but memory has not grown enough", () => {
      const lastRun = new Date(Date.now() - DEFAULT_MIN_INTERVAL_MS - 1);
      expect(
        shouldTriggerExtraction(lastRun, {}, 1500, 1000),
      ).toBe(false);
    });

    it("should return true when time has passed and no lastMemorySize (first run scenario)", () => {
      const lastRun = new Date(Date.now() - DEFAULT_MIN_INTERVAL_MS - 1);
      expect(
        shouldTriggerExtraction(lastRun, {}, 5000, undefined),
      ).toBe(true);
    });

    it("should respect custom minIntervalMs from settings", () => {
      const shortInterval = 1000; // 1 second
      const lastRun = new Date(Date.now() - 2000); // 2 seconds ago
      expect(
        shouldTriggerExtraction(
          lastRun,
          { insightExtractionMinIntervalMs: shortInterval },
          5000,
          1000,
        ),
      ).toBe(true);
    });

    it("should return false when custom interval not met", () => {
      const longInterval = 60 * 60 * 1000; // 1 hour
      const lastRun = new Date(Date.now() - 1000); // 1 second ago
      expect(
        shouldTriggerExtraction(
          lastRun,
          { insightExtractionMinIntervalMs: longInterval },
          5000,
          1000,
        ),
      ).toBe(false);
    });
  });

  // ── getDefaultInsightsTemplate ───────────────────────────────────────

  describe("getDefaultInsightsTemplate", () => {
    it("should return valid markdown with all sections", () => {
      const template = getDefaultInsightsTemplate();
      expect(template).toContain("# Memory Insights");
      expect(template).toContain("## Patterns");
      expect(template).toContain("## Principles");
      expect(template).toContain("## Conventions");
      expect(template).toContain("## Pitfalls");
      expect(template).toContain("## Context");
      expect(template).toContain("## Last Updated:");
    });

    it("should include today's date in Last Updated", () => {
      const today = new Date().toISOString().split("T")[0];
      const template = getDefaultInsightsTemplate();
      expect(template).toContain(`## Last Updated: ${today}`);
    });
  });

  // ── createInsightExtractionAutomation ────────────────────────────────

  describe("createInsightExtractionAutomation", () => {
    it("should return a valid ScheduledTaskCreateInput", () => {
      const result = createInsightExtractionAutomation({});

      expect(result.name).toBe(INSIGHT_EXTRACTION_SCHEDULE_NAME);
      expect(result.scheduleType).toBe("custom");
      expect(result.cronExpression).toBe(DEFAULT_INSIGHT_SCHEDULE);
      expect(result.enabled).toBe(true);
      expect(result.steps).toBeDefined();
      expect(result.steps!.length).toBe(1);
    });

    it("should use ai-prompt step type", () => {
      const result = createInsightExtractionAutomation({});
      const step = result.steps![0];

      expect(step.type).toBe("ai-prompt");
      expect(step.prompt).toBeTruthy();
      expect(step.name).toBeTruthy();
    });

    it("should use custom schedule from settings", () => {
      const settings: Partial<ProjectSettings> = {
        insightExtractionSchedule: "0 3 * * *",
      };
      const result = createInsightExtractionAutomation(settings);

      expect(result.cronExpression).toBe("0 3 * * *");
    });

    it("should default to daily schedule when not specified", () => {
      const result = createInsightExtractionAutomation({});
      expect(result.cronExpression).toBe(DEFAULT_INSIGHT_SCHEDULE);
    });

    it("should include model provider and ID when provided", () => {
      const result = createInsightExtractionAutomation(
        {},
        "anthropic",
        "claude-sonnet-4-5",
      );
      const step = result.steps![0];

      expect(step.modelProvider).toBe("anthropic");
      expect(step.modelId).toBe("claude-sonnet-4-5");
    });

    it("should not include model fields when not provided", () => {
      const result = createInsightExtractionAutomation({});
      const step = result.steps![0];

      expect(step.modelProvider).toBeUndefined();
      expect(step.modelId).toBeUndefined();
    });

    it("should include timeout on the step", () => {
      const result = createInsightExtractionAutomation({});
      const step = result.steps![0];

      expect(step.timeoutMs).toBe(120_000);
    });

    it("should have descriptive automation name and description", () => {
      const result = createInsightExtractionAutomation({});
      expect(result.name).toBe("Memory Insight Extraction");
      expect(result.description).toBeTruthy();
    });
  });

  // ── Constants ────────────────────────────────────────────────────────

  describe("constants", () => {
    it("should have correct file paths", () => {
      expect(MEMORY_WORKING_PATH).toBe(".fusion/memory.md");
      expect(MEMORY_INSIGHTS_PATH).toBe(".fusion/memory-insights.md");
    });

    it("should have sensible defaults", () => {
      expect(DEFAULT_INSIGHT_SCHEDULE).toBe("0 2 * * *");
      expect(DEFAULT_MIN_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
      expect(MIN_INSIGHT_GROWTH_CHARS).toBeGreaterThan(0);
    });
  });
});
