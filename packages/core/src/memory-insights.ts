/**
 * Two-Stage Memory System with Automated Insight Extraction
 *
 * # Research Findings: Multi-Tier Agent Memory Architectures
 *
 * ## Background
 * Agent memory systems typically follow a tiered approach inspired by human
 * memory models (Atkinson-Shiffrin). The two-stage design here follows
 * patterns observed in several frameworks:
 *
 * ## Framework Patterns
 *
 * 1. **Mastra** — Uses a "working memory" (thread-scoped) plus "long-term
 *    memory" (cross-thread) approach. Working memory is ephemeral; long-term
 *    memory persists across conversations. Mastra extracts semantic memories
 *    from conversations using LLM-based processing.
 *
 * 2. **LangChain / LangGraph** — Implements a "short-term" (conversation
 *    buffer) and "long-term" (persistent store) split. LangGraph's
 *    `MemoryManager` supports configurable memory types including episodic
 *    and semantic. Extraction uses LLM summarization.
 *
 * 3. **AutoGPT / MemGPT** — Uses a hierarchical memory system with core
 *    memory (always in-context), archival memory (searchable long-term),
 *    and recall memory (conversation history). MemGPT introduced the concept
 *    of "memory management functions" that the agent calls to move data
 *    between tiers.
 *
 * 4. **QMD (Quantized Memory Distillation)** — A technique for compressing
 *    large memory stores into compact representations while preserving
 *    retrieval quality. The key insight is that not all memories are equally
 *    valuable — distillation prioritizes high-signal observations over noise.
 *
 * ## Design Decisions
 *
 * - **Two files, not a database**: Following the project's file-first
 *   architecture. Markdown files are human-readable, git-diffable, and
 *   require no migration.
 *
 * - **AI-powered extraction**: Insights are distilled by an AI agent that
 *   reads the working memory, identifies patterns, and produces structured
 *   output. This follows the Mastra/LangChain pattern of LLM-based
 *   memory consolidation.
 *
 * - **Scheduled extraction**: Rather than extracting on every write, we use
 *   a scheduled automation (daily by default). This batch approach is more
 *   efficient and allows the AI to see accumulated context.
 *
 * - **Growth threshold**: Extraction only triggers when working memory has
 *   grown by at least MIN_INSIGHT_GROWTH_CHARS characters since last
 *   extraction. This prevents unnecessary AI calls on unchanged memory.
 *
 * ## Retention Policy
 *
 * - **Working memory** (`memory.md`): Manual/agent-maintained. No automatic
 *   pruning — agents are expected to keep it relevant.
 *
 * - **Insights memory** (`memory-insights.md`): Only grows through
 *   extraction. New insights are merged with existing ones. Simple duplicate
 *   detection prevents re-adding the same insight.
 *
 * - **Merge strategy**: New insights are appended to the relevant section.
 *   If an insight is substantially similar to an existing one (exact or
 *   near-exact content match), it is skipped.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSettings } from "./types.js";
import type { ScheduledTaskCreateInput } from "./automation.js";

// ── Constants ────────────────────────────────────────────────────────

/** Path to working memory relative to project root. */
export const MEMORY_WORKING_PATH = ".fusion/memory.md";

/** Path to insights memory relative to project root. */
export const MEMORY_INSIGHTS_PATH = ".fusion/memory-insights.md";

/** Default cron schedule for insight extraction: daily at 2 AM. */
export const DEFAULT_INSIGHT_SCHEDULE = "0 2 * * *";

/** Default minimum interval between extractions: 24 hours. */
export const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Minimum character growth in working memory to trigger extraction. */
export const MIN_INSIGHT_GROWTH_CHARS = 1000;

/** Constant name for the insight extraction automation schedule. */
export const INSIGHT_EXTRACTION_SCHEDULE_NAME = "Memory Insight Extraction";

// ── Type Definitions ─────────────────────────────────────────────────

/** Category of an extracted memory insight. */
export type MemoryInsightCategory =
  | "pattern"
  | "principle"
  | "convention"
  | "pitfall"
  | "context";

/** A single extracted insight from working memory analysis. */
export interface MemoryInsight {
  /** Category classification of the insight. */
  category: MemoryInsightCategory;
  /** The insight text content. */
  content: string;
  /** Optional reference to what triggered this insight. */
  source?: string;
  /** ISO-8601 timestamp of when this insight was extracted. */
  extractedAt: string;
}

/** Result of an insight extraction operation. */
export interface InsightExtractionResult {
  /** Array of extracted insights. */
  insights: MemoryInsight[];
  /** Brief summary of what was extracted. */
  summary: string;
  /** ISO-8601 timestamp of when extraction occurred. */
  extractedAt: string;
}

// ── File I/O ─────────────────────────────────────────────────────────

/**
 * Read the working memory file (`memory.md`).
 *
 * Returns an empty string if the file does not exist, enabling graceful
 * handling when FN-810's memory system is not yet in place.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The working memory content, or empty string if not found.
 */
export async function readWorkingMemory(rootDir: string): Promise<string> {
  const filePath = join(rootDir, MEMORY_WORKING_PATH);
  if (!existsSync(filePath)) {
    return "";
  }
  return readFile(filePath, "utf-8");
}

/**
 * Read the insights memory file (`memory-insights.md`).
 *
 * Returns `null` if the file does not exist, indicating that no insights
 * have been extracted yet. The caller should treat this as "no prior
 * extraction" and pass `null` to `buildInsightExtractionPrompt()`.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The insights memory content, or null if not found.
 */
export async function readInsightsMemory(rootDir: string): Promise<string | null> {
  const filePath = join(rootDir, MEMORY_INSIGHTS_PATH);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFile(filePath, "utf-8");
}

/**
 * Write the insights memory file (`memory-insights.md`).
 *
 * Creates the `.fusion` directory if it does not exist.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param content - The markdown content to write.
 */
export async function writeInsightsMemory(rootDir: string, content: string): Promise<void> {
  const filePath = join(rootDir, MEMORY_INSIGHTS_PATH);
  const dir = join(rootDir, ".fusion");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(filePath, content, "utf-8");
}

// ── AI Prompt Construction ───────────────────────────────────────────

/**
 * Build the AI prompt for insight extraction.
 *
 * This prompt is designed for use with the automation system's `ai-prompt`
 * step type. The AI agent receives the working memory content, any existing
 * insights, and instructions to produce structured JSON output.
 *
 * The prompt instructs the AI to:
 * 1. Read the working memory content
 * 2. Identify patterns, principles, conventions, pitfalls, and context
 * 3. Avoid duplicating existing insights
 * 4. Return structured JSON
 *
 * @param workingMemory - The raw working memory content.
 * @param existingInsights - The existing insights content, or null if none.
 * @returns The constructed prompt string.
 */
export function buildInsightExtractionPrompt(
  workingMemory: string,
  existingInsights: string | null,
): string {
  const existingSection = existingInsights
    ? `
## Existing Insights (already captured — do not duplicate)
${existingInsights}
`
    : "";

  return `You are a memory analysis agent. Your task is to extract valuable insights from accumulated working memory.

## Working Memory (accumulated observations and learnings)
${workingMemory}
${existingSection}
## Your Task
Analyze the working memory and extract insights that should be preserved for the long-term memory.
Focus on:
1. **Patterns**: Recurring themes or approaches that work well
2. **Principles**: Key decisions and their rationale
3. **Conventions**: Project-specific standards or practices
4. **Pitfalls**: Known issues to avoid
5. **Context**: Important background information

## Output Format
Return ONLY a JSON object with this exact structure (no markdown fences, no extra text):
{
  "summary": "Brief summary of what was extracted",
  "insights": [
    {
      "category": "pattern",
      "content": "The insight text",
      "source": "Optional reference to what triggered this insight"
    }
  ]
}

Category must be one of: "pattern", "principle", "convention", "pitfall", "context".
Only include insights not already present in the existing insights.
If no new insights are found, return: {"summary": "No new insights found", "insights": []}`;
}

// ── Response Parsing ─────────────────────────────────────────────────

/**
 * Parse the AI agent's response into structured insights.
 *
 * Attempts to extract a JSON object from the response text. Handles:
 * - Raw JSON responses
 * - JSON wrapped in markdown code fences
 * - JSON with leading/trailing whitespace or text
 *
 * @param response - The raw AI agent response text.
 * @returns Array of parsed MemoryInsight objects.
 * @throws Error if the response cannot be parsed as valid JSON.
 */
export function parseInsightExtractionResponse(response: string): InsightExtractionResult {
  // Try to extract JSON from the response
  let jsonStr = response.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find JSON object in the text (may have leading text before it)
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse insight extraction response as JSON: ${response.slice(0, 200)}`);
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const insights: MemoryInsight[] = [];

  if (Array.isArray(parsed.insights)) {
    const now = new Date().toISOString();
    for (const item of parsed.insights) {
      if (item && typeof item === "object" && typeof item.content === "string" && item.content.trim()) {
        const category = validateCategory(item.category);
        insights.push({
          category,
          content: item.content.trim(),
          source: typeof item.source === "string" ? item.source.trim() : undefined,
          extractedAt: now,
        });
      }
    }
  }

  return {
    insights,
    summary,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Validate and normalize a category string.
 * Returns 'context' for unrecognized categories.
 */
function validateCategory(value: unknown): MemoryInsightCategory {
  const valid: MemoryInsightCategory[] = ["pattern", "principle", "convention", "pitfall", "context"];
  if (typeof value === "string" && valid.includes(value as MemoryInsightCategory)) {
    return value as MemoryInsightCategory;
  }
  return "context";
}

// ── Insight Merging ──────────────────────────────────────────────────

/**
 * Merge new insights into the existing insights markdown.
 *
 * Handles three cases:
 * 1. No existing insights: creates from the default template with new insights
 * 2. Existing insights with no new ones: returns existing unchanged
 * 3. Existing insights with new ones: appends to relevant sections
 *
 * Duplicate detection is based on exact content match (case-insensitive).
 * Insights with content already present in a section are skipped.
 *
 * @param existing - The existing insights markdown content (may be empty string).
 * @param newInsights - Array of new insights to merge.
 * @returns The merged markdown content.
 */
export function mergeInsights(existing: string, newInsights: MemoryInsight[]): string {
  if (newInsights.length === 0) {
    return existing || getDefaultInsightsTemplate();
  }

  const base = existing || getDefaultInsightsTemplate();
  const now = new Date().toISOString().split("T")[0];

  // Group new insights by category, filtering duplicates
  const byCategory = new Map<MemoryInsightCategory, MemoryInsight[]>();
  for (const insight of newInsights) {
    // Check if this content already exists in the base (case-insensitive)
    const normalizedContent = insight.content.toLowerCase();
    if (base.toLowerCase().includes(normalizedContent)) {
      continue;
    }
    const existing = byCategory.get(insight.category) || [];
    existing.push(insight);
    byCategory.set(insight.category, existing);
  }

  let result = base;

  // Map categories to section headers
  const categoryToSection: Record<MemoryInsightCategory, string> = {
    pattern: "## Patterns",
    principle: "## Principles",
    convention: "## Conventions",
    pitfall: "## Pitfalls",
    context: "## Context",
  };

  // Append insights to their respective sections
  for (const [category, insights] of byCategory) {
    const sectionHeader = categoryToSection[category];
    const sectionIndex = result.indexOf(sectionHeader);

    if (sectionIndex !== -1) {
      // Find the next section header or end of file
      const afterHeader = sectionIndex + sectionHeader.length;
      const nextSection = result.indexOf("\n## ", afterHeader);
      const insertPoint = nextSection !== -1 ? nextSection : result.length;

      const lines = insights.map((i) => {
        let line = `- ${i.content}`;
        if (i.source) line += ` (source: ${i.source})`;
        return line;
      }).join("\n");

      result = result.slice(0, insertPoint) + "\n" + lines + result.slice(insertPoint);
    } else {
      // Section doesn't exist yet — add before the "Last Updated" line
      const lastUpdatedIndex = result.indexOf("## Last Updated:");
      const sectionContent = `\n${sectionHeader}\n` +
        insights.map((i) => {
          let line = `- ${i.content}`;
          if (i.source) line += ` (source: ${i.source})`;
          return line;
        }).join("\n") + "\n";

      if (lastUpdatedIndex !== -1) {
        result = result.slice(0, lastUpdatedIndex) + sectionContent + result.slice(lastUpdatedIndex);
      } else {
        result += sectionContent;
      }
    }
  }

  // Update the "Last Updated" timestamp
  result = result.replace(
    /## Last Updated:.*$/m,
    `## Last Updated: ${now}`,
  );

  return result;
}

// ── Extraction Trigger Logic ─────────────────────────────────────────

/**
 * Determine whether insight extraction should be triggered.
 *
 * Extraction is triggered when BOTH conditions are met:
 * 1. Sufficient time has elapsed since the last extraction (default: 24 hours)
 * 2. Working memory has grown significantly since last extraction (default: >1000 chars)
 *
 * If there has been no prior extraction (lastRun is undefined), extraction
 * is triggered as long as the working memory has content.
 *
 * @param lastRun - Timestamp of the last extraction, or undefined if never run.
 * @param settings - Project settings containing extraction configuration.
 * @param workingMemorySize - Current size of working memory in characters.
 * @param lastMemorySize - Size of working memory at last extraction, or undefined.
 * @returns True if extraction should be triggered.
 */
export function shouldTriggerExtraction(
  lastRun: Date | undefined,
  settings: Partial<ProjectSettings>,
  workingMemorySize: number,
  lastMemorySize: number | undefined,
): boolean {
  // Must have working memory content
  if (workingMemorySize === 0) {
    return false;
  }

  // If never run before, trigger if there's content
  if (!lastRun) {
    return workingMemorySize > 0;
  }

  // Check time threshold
  const minInterval = settings.insightExtractionMinIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const elapsed = Date.now() - lastRun.getTime();
  if (elapsed < minInterval) {
    return false;
  }

  // Check growth threshold
  if (lastMemorySize !== undefined) {
    const growth = workingMemorySize - lastMemorySize;
    if (growth < MIN_INSIGHT_GROWTH_CHARS) {
      return false;
    }
  }

  return true;
}

// ── Default Template ─────────────────────────────────────────────────

/**
 * Get the default template for the insights memory file.
 *
 * The template provides section headers matching the insight categories,
 * with a "Last Updated" timestamp at the bottom.
 *
 * @returns The default markdown template string.
 */
export function getDefaultInsightsTemplate(): string {
  const today = new Date().toISOString().split("T")[0];
  return `# Memory Insights

## Patterns
<!-- Recurring themes that work well -->

## Principles
<!-- Key principles to follow -->

## Conventions
<!-- Project-specific standards -->

## Pitfalls
<!-- Known issues to avoid -->

## Context
<!-- Important background information -->

## Last Updated: ${today}
`;
}

// ── Automation Integration ───────────────────────────────────────────

/**
 * Create the automation config for insight extraction.
 *
 * Returns a `ScheduledTaskCreateInput` ready for `AutomationStore.createSchedule()`.
 * The automation uses a single `ai-prompt` step that runs the insight
 * extraction prompt against the working memory.
 *
 * The AI model provider and ID are optional — when not specified, the
 * automation system falls back to the project's default model.
 *
 * @param settings - Project settings for schedule configuration.
 * @param modelProvider - Optional AI model provider override.
 * @param modelId - Optional AI model ID override.
 * @returns The automation creation input.
 */
export function createInsightExtractionAutomation(
  settings: Partial<ProjectSettings>,
  modelProvider?: string,
  modelId?: string,
): ScheduledTaskCreateInput {
  const schedule = settings.insightExtractionSchedule ?? DEFAULT_INSIGHT_SCHEDULE;

  // Build the prompt that reads working memory and existing insights.
  // Note: At automation execution time, the AI agent has access to the
  // filesystem and can read the memory files directly.
  const prompt = `You are the Memory Insight Extraction agent. Your job is to analyze the project's working memory and extract long-term insights.

## Instructions

1. Read the working memory file at \`.fusion/memory.md\` using your file reading tools
2. Read the existing insights file at \`.fusion/memory-insights.md\` (it may not exist yet)
3. Analyze the working memory content and identify new insights that should be preserved
4. Focus on extracting:
   - **Patterns**: Recurring themes or approaches that work well
   - **Principles**: Key decisions and their rationale
   - **Conventions**: Project-specific standards or practices
   - **Pitfalls**: Known issues to avoid
   - **Context**: Important background information
5. Output ONLY a JSON object with this structure:
{
  "summary": "Brief summary of what was extracted",
  "insights": [
    {
      "category": "pattern|principle|convention|pitfall|context",
      "content": "The insight text",
      "source": "Optional reference to what triggered this insight"
    }
  ]
}
6. Do not duplicate insights already in the existing insights file
7. If no new insights are found, return: {"summary": "No new insights found", "insights": []}

If the working memory file does not exist or is empty, return: {"summary": "No working memory to analyze", "insights": []}`;

  return {
    name: INSIGHT_EXTRACTION_SCHEDULE_NAME,
    description: "Extracts insights from working memory into long-term memory",
    scheduleType: "custom",
    cronExpression: schedule,
    command: "", // Required by type but unused when steps are present
    enabled: true,
    steps: [
      {
        id: "memory-insight-extraction",
        type: "ai-prompt",
        name: "Extract Memory Insights",
        prompt,
        ...(modelProvider && modelId ? { modelProvider, modelId } : {}),
        timeoutMs: 120_000, // 2 minutes
      },
    ],
  };
}

/**
 * Synchronize the insight extraction automation with project settings.
 *
 * Creates, updates, or deletes the automation schedule based on whether
 * insight extraction is enabled in the project settings. Follows the same
 * pattern as `syncBackupAutomation()` from the backup module.
 *
 * @param automationStore - The AutomationStore instance.
 * @param settings - Current project settings.
 * @returns The created/updated schedule, or undefined if deleted/disabled.
 */
export async function syncInsightExtractionAutomation(
  automationStore: import("./automation-store.js").AutomationStore,
  settings: Partial<ProjectSettings>,
): Promise<import("./automation.js").ScheduledTask | undefined> {
  const { AutomationStore } = await import("./automation-store.js");

  // Find existing insight extraction schedule by name
  const schedules = await automationStore.listSchedules();
  const existingSchedule = schedules.find(
    (s) => s.name === INSIGHT_EXTRACTION_SCHEDULE_NAME,
  );

  // If extraction is disabled, delete existing schedule if present
  if (!settings.insightExtractionEnabled) {
    if (existingSchedule) {
      await automationStore.deleteSchedule(existingSchedule.id);
    }
    return undefined;
  }

  // Validate the cron schedule
  const schedule = settings.insightExtractionSchedule ?? DEFAULT_INSIGHT_SCHEDULE;
  if (!AutomationStore.isValidCron(schedule)) {
    throw new Error(`Invalid insight extraction schedule: ${schedule}`);
  }

  // Build the automation input
  const input = createInsightExtractionAutomation(settings);

  if (existingSchedule) {
    // Update existing schedule
    return await automationStore.updateSchedule(existingSchedule.id, {
      scheduleType: "custom",
      cronExpression: schedule,
      command: input.command,
      steps: input.steps,
      enabled: true,
    });
  } else {
    // Create new schedule
    return await automationStore.createSchedule(input);
  }
}
