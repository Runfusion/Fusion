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

// ── Audit File Operations ──────────────────────────────────────────────

import {
  MEMORY_AUDIT_PATH,
  readMemoryAudit,
  writeMemoryAudit,
} from "./memory-insights.js";

describe("memory-insights audit file operations", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-memory-audit-test-"));
    await mkdir(join(tempDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("readMemoryAudit", () => {
    it("should return null when audit file does not exist", async () => {
      const result = await readMemoryAudit(tempDir);
      expect(result).toBeNull();
    });

    it("should return content when audit file exists", async () => {
      const content = "# Memory Audit Report\n\nGenerated...";
      writeFileSync(join(tempDir, MEMORY_AUDIT_PATH), content);

      const result = await readMemoryAudit(tempDir);
      expect(result).toBe(content);
    });
  });

  describe("writeMemoryAudit", () => {
    it("should create the audit file", async () => {
      const content = "# Memory Audit Report\n\nGenerated...";
      await writeMemoryAudit(tempDir, content);

      const filePath = join(tempDir, MEMORY_AUDIT_PATH);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe(content);
    });

    it("should overwrite existing content", async () => {
      writeFileSync(join(tempDir, MEMORY_AUDIT_PATH), "old content");
      await writeMemoryAudit(tempDir, "new content");

      expect(readFileSync(join(tempDir, MEMORY_AUDIT_PATH), "utf-8")).toBe("new content");
    });

    it("should create .fusion directory if it does not exist", async () => {
      const newDir = join(tempDir, "new-project");
      await mkdir(newDir, { recursive: true });
      await writeMemoryAudit(newDir, "test content");
      expect(existsSync(join(newDir, MEMORY_AUDIT_PATH))).toBe(true);
    });
  });
});

// ── Run Processing ─────────────────────────────────────────────────────

import {
  processInsightExtractionRun,
  processAndAuditInsightExtraction,
} from "./memory-insights.js";

describe("memory-insights run processing", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-memory-run-test-"));
    await mkdir(join(tempDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("processInsightExtractionRun", () => {
    it("should parse and merge successful extraction", async () => {
      // No existing insights
      const rawResponse = JSON.stringify({
        summary: "Found 2 new insights",
        insights: [
          { category: "pattern", content: "Use TypeScript for type safety" },
          { category: "pitfall", content: "Avoid any type assertions" },
        ],
      });

      const result = await processInsightExtractionRun(tempDir, {
        rawResponse,
        stepSuccess: true,
        runAt: new Date().toISOString(),
      });

      expect(result.insights).toHaveLength(2);
      expect(result.summary).toBe("Found 2 new insights");
      expect(result.newInsightCount).toBe(2);
      expect(result.duplicateCount).toBe(0);

      // Verify insights file was written
      const insightsPath = join(tempDir, MEMORY_INSIGHTS_PATH);
      expect(existsSync(insightsPath)).toBe(true);
      const content = readFileSync(insightsPath, "utf-8");
      expect(content).toContain("Use TypeScript for type safety");
      expect(content).toContain("Avoid any type assertions");
    });

    it("should handle existing insights without duplicating", async () => {
      // Create existing insights
      const existingInsights = `# Memory Insights

## Patterns
- Already existing pattern

## Last Updated: 2026-01-01
`;
      writeFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), existingInsights);

      const rawResponse = JSON.stringify({
        summary: "Found 1 new insight",
        insights: [
          { category: "pattern", content: "Already existing pattern" }, // duplicate
          { category: "principle", content: "New principle" }, // new
        ],
      });

      const result = await processInsightExtractionRun(tempDir, {
        rawResponse,
        stepSuccess: true,
        runAt: new Date().toISOString(),
      });

      expect(result.insights).toHaveLength(2);
      expect(result.duplicateCount).toBe(1);
      expect(result.newInsightCount).toBe(1);

      // Verify only new insight was added
      const content = readFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), "utf-8");
      expect(content).toContain("Already existing pattern");
      expect(content).toContain("New principle");
      // Should only have "Already existing pattern" once
      expect(content.match(/Already existing pattern/g)?.length).toBe(1);
    });

    it("should handle malformed JSON gracefully", async () => {
      const result = await processInsightExtractionRun(tempDir, {
        rawResponse: "not valid json at all",
        stepSuccess: true,
        runAt: new Date().toISOString(),
      });

      expect(result.insights).toHaveLength(0);
      expect(result.summary).toContain("Parse error");
    });

    it("should handle failed step", async () => {
      const result = await processInsightExtractionRun(tempDir, {
        rawResponse: "",
        stepSuccess: false,
        runAt: new Date().toISOString(),
        error: "AI timeout",
      });

      expect(result.insights).toHaveLength(0);
      expect(result.summary).toContain("AI timeout");
    });

    it("should preserve existing insights on failure", async () => {
      // Create existing insights
      const existingInsights = `# Memory Insights

## Patterns
- Important existing pattern

## Last Updated: 2026-01-01
`;
      writeFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), existingInsights);

      // Process with malformed JSON
      await processInsightExtractionRun(tempDir, {
        rawResponse: "invalid",
        stepSuccess: true,
        runAt: new Date().toISOString(),
      });

      // Existing insights should be preserved
      const content = readFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), "utf-8");
      expect(content).toContain("Important existing pattern");
    });
  });

  describe("processAndAuditInsightExtraction", () => {
    it("should process run and generate audit report", async () => {
      // Create working memory
      writeFileSync(
        join(tempDir, MEMORY_WORKING_PATH),
        "## Architecture\n\nSome architecture notes\n## Conventions\n\nSome conventions",
      );

      const rawResponse = JSON.stringify({
        summary: "Extracted insights",
        insights: [{ category: "pattern", content: "Test pattern" }],
      });

      const report = await processAndAuditInsightExtraction(tempDir, {
        rawResponse,
        stepSuccess: true,
        runAt: new Date().toISOString(),
      });

      expect(report).toBeDefined();
      expect(report.health).toBeDefined();
      expect(report.checks).toBeDefined();
      expect(report.checks.length).toBeGreaterThan(0);

      // Verify audit file was written
      const auditPath = join(tempDir, MEMORY_AUDIT_PATH);
      expect(existsSync(auditPath)).toBe(true);
      const auditContent = readFileSync(auditPath, "utf-8");
      expect(auditContent).toContain("Memory Audit Report");
    });

    it("should generate audit with failed extraction", async () => {
      writeFileSync(
        join(tempDir, MEMORY_WORKING_PATH),
        "## Architecture\n\nNotes",
      );

      const report = await processAndAuditInsightExtraction(tempDir, {
        rawResponse: "",
        stepSuccess: false,
        runAt: new Date().toISOString(),
        error: "Step timed out",
      });

      expect(report.extraction.success).toBe(false);
      expect(report.extraction.error).toBe("Step timed out");
      expect(report.checks).toBeDefined();
    });
  });
});

// ── Audit Generation ──────────────────────────────────────────────────

import {
  generateMemoryAudit,
  renderMemoryAuditMarkdown,
} from "./memory-insights.js";

describe("memory-insights audit generation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-memory-audit-gen-test-"));
    await mkdir(join(tempDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("generateMemoryAudit", () => {
    it("should detect missing working memory", async () => {
      const report = await generateMemoryAudit(tempDir);

      const check = report.checks.find((c) => c.id === "working-memory-exists");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(false);
    });

    it("should detect present working memory", async () => {
      writeFileSync(
        join(tempDir, MEMORY_WORKING_PATH),
        "## Architecture\n\nSome architecture\n## Conventions\n\nSome conventions",
      );

      const report = await generateMemoryAudit(tempDir);

      const check = report.checks.find((c) => c.id === "working-memory-exists");
      expect(check!.passed).toBe(true);
      expect(report.workingMemory.exists).toBe(true);
      expect(report.workingMemory.size).toBeGreaterThan(0);
    });

    it("should count insights in insights memory", async () => {
      writeFileSync(
        join(tempDir, MEMORY_INSIGHTS_PATH),
        `# Memory Insights

## Patterns
- Pattern 1
- Pattern 2

## Principles
- Principle 1

## Last Updated: 2026-04-09
`,
      );

      const report = await generateMemoryAudit(tempDir);

      expect(report.insightsMemory.exists).toBe(true);
      expect(report.insightsMemory.categories.pattern).toBe(2);
      expect(report.insightsMemory.categories.principle).toBe(1);
      expect(report.insightsMemory.insightCount).toBe(3);
    });

    it("should include extraction info when provided", async () => {
      writeFileSync(join(tempDir, MEMORY_WORKING_PATH), "## Architecture\n\nNotes");

      const report = await generateMemoryAudit(tempDir, {
        runAt: new Date().toISOString(),
        success: true,
        insightCount: 5,
        duplicateCount: 2,
        skippedCount: 0,
        summary: "Found 5 new patterns",
      });

      expect(report.extraction.runAt).toBeTruthy();
      expect(report.extraction.success).toBe(true);
      expect(report.extraction.insightCount).toBe(5);
      expect(report.extraction.duplicateCount).toBe(2);
    });

    it("should calculate health status", async () => {
      // No files = issues
      const noFilesReport = await generateMemoryAudit(tempDir);
      expect(["healthy", "warning", "issues"]).toContain(noFilesReport.health);

      // All good
      writeFileSync(
        join(tempDir, MEMORY_WORKING_PATH),
        "## Architecture\n\n## Conventions\n\n## Pitfalls\n\nNotes",
      );
      writeFileSync(
        join(tempDir, MEMORY_INSIGHTS_PATH),
        `# Memory Insights

## Patterns
- Pattern 1

## Last Updated: 2026-04-09
`,
      );

      const goodReport = await generateMemoryAudit(tempDir, {
        runAt: new Date().toISOString(),
        success: true,
        insightCount: 1,
        duplicateCount: 0,
        skippedCount: 0,
        summary: "Found patterns",
      });

      expect(goodReport.health).toBe("healthy");
    });
  });

  describe("renderMemoryAuditMarkdown", () => {
    it("should render a complete audit report", async () => {
      writeFileSync(join(tempDir, MEMORY_WORKING_PATH), "## Architecture\n\nNotes");
      writeFileSync(join(tempDir, MEMORY_INSIGHTS_PATH), "# Memory Insights\n\n## Patterns\n- Pattern 1\n\n## Last Updated: 2026-04-09");

      const report = await generateMemoryAudit(tempDir, {
        runAt: new Date().toISOString(),
        success: true,
        insightCount: 1,
        duplicateCount: 0,
        skippedCount: 0,
        summary: "Test summary",
      });

      const markdown = renderMemoryAuditMarkdown(report);

      expect(markdown).toContain("# Memory Audit Report");
      expect(markdown).toContain("## Working Memory");
      expect(markdown).toContain("## Insights Memory");
      expect(markdown).toContain("## Last Extraction");
      expect(markdown).toContain("## Audit Checks");
      expect(markdown).toContain("Health:");
    });

    it("should handle empty report", async () => {
      const report = await generateMemoryAudit(tempDir);
      const markdown = renderMemoryAuditMarkdown(report);

      expect(markdown).toContain("Memory Audit Report");
      expect(markdown).toContain("Working Memory");
      expect(markdown).toContain("Insights Memory");
    });
  });
});
