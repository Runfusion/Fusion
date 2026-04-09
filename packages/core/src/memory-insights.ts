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

/** Path to memory audit report relative to project root. */
export const MEMORY_AUDIT_PATH = ".fusion/memory-audit.md";

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

// ── Run Processing Types ───────────────────────────────────────────────

/** Individual audit check result. */
export interface MemoryAuditCheck {
  /** Unique identifier for this check. */
  id: string;
  /** Human-readable check name. */
  name: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Details about the check result. */
  details: string;
}

/** Result of a memory audit run. */
export interface MemoryAuditReport {
  /** ISO-8601 timestamp of the audit. */
  generatedAt: string;
  /** Working memory file status. */
  workingMemory: {
    exists: boolean;
    size: number;
    sectionCount: number;
    lastModified?: string;
  };
  /** Insights memory file status. */
  insightsMemory: {
    exists: boolean;
    size: number;
    insightCount: number;
    categories: Record<MemoryInsightCategory, number>;
    lastUpdated?: string;
  };
  /** Extraction metadata. */
  extraction: {
    runAt: string;
    success: boolean;
    insightCount: number;
    duplicateCount: number;
    skippedCount: number;
    summary: string;
    error?: string;
  };
  /** Individual audit checks. */
  checks: MemoryAuditCheck[];
  /** Overall health status. */
  health: "healthy" | "warning" | "issues";
}

/** Input for processing an insight extraction run. */
export interface ProcessRunInput {
  /** Raw AI response text from the insight extraction step. */
  rawResponse: string;
  /** Whether the AI step itself succeeded. */
  stepSuccess: boolean;
  /** Timestamp of the run. */
  runAt: string;
  /** Optional error message if the step failed. */
  error?: string;
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

/**
 * Read the memory audit file (`memory-audit.md`).
 *
 * Returns `null` if the file does not exist.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The audit file content, or null if not found.
 */
export async function readMemoryAudit(rootDir: string): Promise<string | null> {
  const filePath = join(rootDir, MEMORY_AUDIT_PATH);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFile(filePath, "utf-8");
}

/**
 * Write the memory audit file (`memory-audit.md`).
 *
 * Creates the `.fusion` directory if it does not exist.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param content - The markdown content to write.
 */
export async function writeMemoryAudit(rootDir: string, content: string): Promise<void> {
  const filePath = join(rootDir, MEMORY_AUDIT_PATH);
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

// ── Run Processing ─────────────────────────────────────────────────────

/**
 * Process an insight extraction run and persist results.
 *
 * This function takes the raw AI response from an insight extraction step,
 * parses it, merges new insights into the insights memory file, and generates
 * an audit report.
 *
 * **Safety guarantees:**
 * - Malformed AI output does not destroy existing insights content
 * - Failures are surfaced as controlled errors and keep prior files intact
 * - All operations are atomic where possible
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param input - The run processing input containing raw response and metadata.
 * @returns The processed insight extraction result, or throws on failure.
 * @throws Error if processing fails after all recovery attempts.
 */
export async function processInsightExtractionRun(
  rootDir: string,
  input: ProcessRunInput,
): Promise<InsightExtractionResult & { newInsightCount: number; duplicateCount: number }> {
  const { rawResponse, stepSuccess, runAt, error: stepError } = input;

  // Read existing insights before any modification
  const existingInsights = await readInsightsMemory(rootDir);

  let parsedResult: InsightExtractionResult;
  let parseError: string | undefined;

  // Try to parse the AI response
  if (stepSuccess && rawResponse.trim()) {
    try {
      parsedResult = parseInsightExtractionResponse(rawResponse);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
      // Create a fallback result that indicates the parse failure
      parsedResult = {
        insights: [],
        summary: `Parse error: ${parseError}`,
        extractedAt: runAt,
      };
    }
  } else {
    parsedResult = {
      insights: [],
      summary: stepError || "Step did not produce output",
      extractedAt: runAt,
    };
  }

  // Calculate duplicate count before merging
  const duplicateCount = countDuplicateInsights(existingInsights ?? "", parsedResult.insights);
  const newInsights = parsedResult.insights;

  // Merge new insights into insights memory
  let newInsightsContent: string;
  if (existingInsights !== null) {
    newInsightsContent = mergeInsights(existingInsights, newInsights);
  } else {
    newInsightsContent = mergeInsights("", newInsights);
  }

  // Write the updated insights file
  // Note: We write unconditionally to capture even empty merges
  // The merge function returns existing unchanged when there are no new insights
  await writeInsightsMemory(rootDir, newInsightsContent);

  // Count actual new insights added (by comparing before/after)
  const beforeCount = countInsightsInMarkdown(existingInsights ?? "");
  const afterCount = countInsightsInMarkdown(newInsightsContent);
  const newInsightCount = Math.max(0, afterCount - beforeCount);

  return {
    ...parsedResult,
    newInsightCount,
    duplicateCount,
  };
}

/**
 * Count insights that would be duplicates against existing content.
 *
 * @param existingContent - The existing insights markdown content.
 * @param newInsights - Array of new insights to check.
 * @returns The number of insights that already exist (case-insensitive match).
 */
function countDuplicateInsights(
  existingContent: string,
  newInsights: MemoryInsight[],
): number {
  if (!existingContent || newInsights.length === 0) {
    return 0;
  }

  let duplicateCount = 0;
  for (const insight of newInsights) {
    if (existingContent.toLowerCase().includes(insight.content.toLowerCase())) {
      duplicateCount++;
    }
  }
  return duplicateCount;
}

/**
 * Count the number of insights (bullet points) in a markdown string.
 *
 * @param markdown - The markdown content to count insights in.
 * @returns The number of insight bullet points found.
 */
function countInsightsInMarkdown(markdown: string): number {
  if (!markdown) return 0;
  // Count lines that start with "- " and are inside section headers
  // Simple heuristic: count all "- " lines that are indented or follow section headers
  const lines = markdown.split("\n");
  let inSection = false;
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      inSection = true;
    } else if (trimmed.startsWith("# ") || trimmed.startsWith("<!--")) {
      // Title or comment, not a section
    } else if (inSection && trimmed.startsWith("- ")) {
      count++;
    }
  }

  return count;
}

// ── Audit Generation ─────────────────────────────────────────────────────

/**
 * Generate a memory audit report.
 *
 * The audit checks include:
 * - Working memory file presence and structure
 * - Insights memory file presence and content
 * - Required section headers in working memory
 * - Memory size and change metadata
 * - Duplicate/empty insight handling
 * - Extraction timestamp and summary
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param lastExtraction - Optional information about the last extraction run.
 * @returns The generated audit report.
 */
export async function generateMemoryAudit(
  rootDir: string,
  lastExtraction?: {
    runAt: string;
    success: boolean;
    insightCount: number;
    duplicateCount: number;
    skippedCount: number;
    summary: string;
    error?: string;
  },
): Promise<MemoryAuditReport> {
  const checks: MemoryAuditCheck[] = [];
  const now = new Date().toISOString();

  // ── Check 1: Working memory file presence ──────────────────────────
  const workingMemoryPath = join(rootDir, MEMORY_WORKING_PATH);
  const workingMemoryExists = existsSync(workingMemoryPath);
  let workingMemorySize = 0;
  let workingMemorySectionCount = 0;
  let workingMemoryContent = "";

  if (workingMemoryExists) {
    try {
      workingMemoryContent = await readFile(workingMemoryPath, "utf-8");
      workingMemorySize = workingMemoryContent.length;
      workingMemorySectionCount = countMarkdownSections(workingMemoryContent);

      checks.push({
        id: "working-memory-exists",
        name: "Working memory file exists",
        passed: true,
        details: `File exists with ${workingMemorySize} characters and ${workingMemorySectionCount} sections`,
      });
    } catch (err) {
      checks.push({
        id: "working-memory-exists",
        name: "Working memory file exists",
        passed: false,
        details: `File exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({
      id: "working-memory-exists",
      name: "Working memory file exists",
      passed: false,
      details: "File .fusion/memory.md does not exist",
    });
  }

  // ── Check 2: Working memory has meaningful content ──────────────────
  if (workingMemoryExists) {
    const hasContent = workingMemorySize > 0;
    const hasSections = workingMemorySectionCount >= 2;

    checks.push({
      id: "working-memory-content",
      name: "Working memory has meaningful content",
      passed: hasContent && hasSections,
      details: hasContent
        ? `Has ${workingMemorySize} characters with ${workingMemorySectionCount} sections`
        : "Working memory is empty",
    });
  }

  // ── Check 3: Working memory has required sections ──────────────────
  if (workingMemoryContent) {
    const requiredSections = ["Architecture", "Conventions", "Pitfalls"];
    const foundSections = requiredSections.filter((section) =>
      workingMemoryContent.includes(`## ${section}`),
    );

    checks.push({
      id: "working-memory-sections",
      name: "Working memory has required sections",
      passed: foundSections.length >= 2, // At least 2 of 3 recommended
      details: foundSections.length >= 2
        ? `Found sections: ${foundSections.join(", ")}`
        : `Missing sections: ${requiredSections.filter((s) => !foundSections.includes(s)).join(", ")}`,
    });
  }

  // ── Check 4: Insights memory file presence ──────────────────────────
  const insightsMemoryPath = join(rootDir, MEMORY_INSIGHTS_PATH);
  const insightsMemoryExists = existsSync(insightsMemoryPath);
  let insightsMemorySize = 0;
  let insightsMemoryContent = "";
  const categoryCounts: Record<MemoryInsightCategory, number> = {
    pattern: 0,
    principle: 0,
    convention: 0,
    pitfall: 0,
    context: 0,
  };
  let lastUpdated: string | undefined;

  if (insightsMemoryExists) {
    try {
      insightsMemoryContent = await readFile(insightsMemoryPath, "utf-8");
      insightsMemorySize = insightsMemoryContent.length;

      // Count insights by category
      for (const [category, header] of Object.entries({
        pattern: "## Patterns",
        principle: "## Principles",
        convention: "## Conventions",
        pitfall: "## Pitfalls",
        context: "## Context",
      })) {
        categoryCounts[category as MemoryInsightCategory] = countInsightsInSection(
          insightsMemoryContent,
          header,
        );
      }

      // Find last updated timestamp
      const lastUpdatedMatch = insightsMemoryContent.match(/## Last Updated:\s*(.+)$/m);
      if (lastUpdatedMatch) {
        lastUpdated = lastUpdatedMatch[1].trim();
      }

      checks.push({
        id: "insights-memory-exists",
        name: "Insights memory file exists",
        passed: true,
        details: `File exists with ${insightsMemorySize} characters`,
      });
    } catch (err) {
      checks.push({
        id: "insights-memory-exists",
        name: "Insights memory file exists",
        passed: false,
        details: `File exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({
      id: "insights-memory-exists",
      name: "Insights memory file exists",
      passed: false,
      details: "File .fusion/memory-insights.md does not exist yet",
    });
  }

  // ── Check 5: Insights memory has content ───────────────────────────
  if (insightsMemoryExists) {
    const totalInsights = Object.values(categoryCounts).reduce((a, b) => a + b, 0);
    checks.push({
      id: "insights-memory-content",
      name: "Insights memory has content",
      passed: totalInsights > 0,
      details: totalInsights > 0
        ? `Contains ${totalInsights} insights across categories: patterns=${categoryCounts.pattern}, principles=${categoryCounts.principle}, conventions=${categoryCounts.convention}, pitfalls=${categoryCounts.pitfall}, context=${categoryCounts.context}`
        : "No insights extracted yet",
    });
  }

  // ── Check 6: Recent extraction activity ───────────────────────────
  if (lastExtraction) {
    const extractionAge = Date.now() - new Date(lastExtraction.runAt).getTime();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

    checks.push({
      id: "recent-extraction",
      name: "Recent extraction activity",
      passed: lastExtraction.success && extractionAge < oneWeekMs,
      details: lastExtraction.success
        ? `Last successful extraction ${formatTimeAgo(lastExtraction.runAt)} (${lastExtraction.insightCount} insights, ${lastExtraction.duplicateCount} duplicates skipped)`
        : `Last extraction failed: ${lastExtraction.error || "Unknown error"}`,
    });

    // Check 7: Extraction summary quality
    checks.push({
      id: "extraction-summary",
      name: "Extraction produces meaningful summaries",
      passed: lastExtraction.success && lastExtraction.summary.length > 10,
      details: lastExtraction.success
        ? `Summary: "${lastExtraction.summary.slice(0, 100)}${lastExtraction.summary.length > 100 ? "..." : ""}"`
        : "No meaningful summary available",
    });
  } else {
    checks.push({
      id: "recent-extraction",
      name: "Recent extraction activity",
      passed: false,
      details: "No extraction runs recorded",
    });
  }

  // ── Calculate overall health ──────────────────────────────────────
  const failedChecks = checks.filter((c) => !c.passed);
  let health: "healthy" | "warning" | "issues" = "healthy";

  if (failedChecks.length >= 3) {
    health = "issues";
  } else if (failedChecks.length >= 1) {
    // Critical checks that affect health
    const criticalFailed = failedChecks.filter((c) =>
      ["working-memory-exists", "insights-memory-exists", "recent-extraction"].includes(c.id),
    );
    health = criticalFailed.length > 0 ? "issues" : "warning";
  }

  return {
    generatedAt: now,
    workingMemory: {
      exists: workingMemoryExists,
      size: workingMemorySize,
      sectionCount: workingMemorySectionCount,
    },
    insightsMemory: {
      exists: insightsMemoryExists,
      size: insightsMemorySize,
      insightCount: Object.values(categoryCounts).reduce((a, b) => a + b, 0),
      categories: categoryCounts,
      lastUpdated,
    },
    extraction: lastExtraction
      ? {
          runAt: lastExtraction.runAt,
          success: lastExtraction.success,
          insightCount: lastExtraction.insightCount,
          duplicateCount: lastExtraction.duplicateCount,
          skippedCount: lastExtraction.skippedCount,
          summary: lastExtraction.summary,
          error: lastExtraction.error,
        }
      : {
          runAt: "",
          success: false,
          insightCount: 0,
          duplicateCount: 0,
          skippedCount: 0,
          summary: "No extraction runs recorded",
        },
    checks,
    health,
  };
}

/**
 * Count markdown sections (## headers) in content.
 *
 * @param content - The markdown content to analyze.
 * @returns The number of level-2 section headers.
 */
function countMarkdownSections(content: string): number {
  const matches = content.match(/^##\s+.+$/gm);
  return matches ? matches.length : 0;
}

/**
 * Count insight bullet points in a specific section.
 *
 * @param content - The markdown content.
 * @param sectionHeader - The section header to look for (e.g., "## Patterns").
 * @returns The number of insights (bullet points) in that section.
 */
function countInsightsInSection(content: string, sectionHeader: string): number {
  const headerIndex = content.indexOf(sectionHeader);
  if (headerIndex === -1) return 0;

  // Find the next section header or end of file
  const afterHeader = headerIndex + sectionHeader.length;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const sectionContent =
    nextSection === -1
      ? content.slice(afterHeader)
      : content.slice(afterHeader, nextSection);

  // Count lines starting with "- "
  const lines = sectionContent.split("\n");
  return lines.filter((line) => line.trim().startsWith("- ")).length;
}

/**
 * Format a timestamp as a human-readable "time ago" string.
 *
 * @param isoTimestamp - ISO-8601 timestamp.
 * @returns Human-readable time ago string.
 */
function formatTimeAgo(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = Date.now();
  const diffMs = now - date.getTime();

  const minutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Render a memory audit report as markdown.
 *
 * @param report - The audit report to render.
 * @returns Markdown-formatted audit report.
 */
export function renderMemoryAuditMarkdown(report: MemoryAuditReport): string {
  const lines: string[] = [];

  lines.push(`# Memory Audit Report`);
  lines.push(``);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Health:** ${getHealthEmoji(report.health)} ${report.health}`);
  lines.push(``);

  // Working Memory Section
  lines.push(`## Working Memory`);
  lines.push(`- **Exists:** ${report.workingMemory.exists ? "✓" : "✗"}`);
  lines.push(`- **Size:** ${report.workingMemory.size.toLocaleString()} characters`);
  lines.push(`- **Sections:** ${report.workingMemory.sectionCount}`);
  lines.push(``);

  // Insights Memory Section
  lines.push(`## Insights Memory`);
  lines.push(`- **Exists:** ${report.insightsMemory.exists ? "✓" : "✗"}`);
  lines.push(`- **Size:** ${report.insightsMemory.size.toLocaleString()} characters`);
  lines.push(`- **Total Insights:** ${report.insightsMemory.insightCount}`);
  lines.push(`- **By Category:**`);
  for (const [category, count] of Object.entries(report.insightsMemory.categories)) {
    lines.push(`  - ${category}: ${count}`);
  }
  if (report.insightsMemory.lastUpdated) {
    lines.push(`- **Last Updated:** ${report.insightsMemory.lastUpdated}`);
  }
  lines.push(``);

  // Extraction Section
  lines.push(`## Last Extraction`);
  if (report.extraction.runAt) {
    lines.push(`- **Run At:** ${report.extraction.runAt}`);
    lines.push(`- **Success:** ${report.extraction.success ? "✓" : "✗"}`);
    lines.push(`- **Insights Extracted:** ${report.extraction.insightCount}`);
    lines.push(`- **Duplicates Skipped:** ${report.extraction.duplicateCount}`);
    lines.push(`- **Skipped:** ${report.extraction.skippedCount}`);
    lines.push(`- **Summary:** ${report.extraction.summary}`);
    if (report.extraction.error) {
      lines.push(`- **Error:** ${report.extraction.error}`);
    }
  } else {
    lines.push(`- No extraction runs recorded`);
  }
  lines.push(``);

  // Checks Section
  lines.push(`## Audit Checks`);
  for (const check of report.checks) {
    const icon = check.passed ? "✓" : "✗";
    lines.push(`### ${icon} ${check.name}`);
    lines.push(`**${check.details}**`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Get the emoji for a health status.
 *
 * @param health - The health status.
 * @returns The corresponding emoji.
 */
function getHealthEmoji(health: "healthy" | "warning" | "issues"): string {
  switch (health) {
    case "healthy":
      return "✅";
    case "warning":
      return "⚠️";
    case "issues":
      return "❌";
  }
}

/**
 * Process an insight extraction run and generate an audit report.
 *
 * This is a convenience function that combines:
 * 1. Processing the insight extraction run (parsing, merging, writing)
 * 2. Generating an audit report
 * 3. Writing the audit report to disk
 *
 * All operations are performed as best-effort side effects. Failures are
 * logged but do not cause the function to throw. The audit report always
 * reflects the current state of the memory files.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param input - The run processing input containing raw response and metadata.
 * @returns The audit report generated after processing (never throws).
 */
export async function processAndAuditInsightExtraction(
  rootDir: string,
  input: ProcessRunInput,
): Promise<MemoryAuditReport> {
  // Track extraction info for the audit
  let extractionInfo: {
    runAt: string;
    success: boolean;
    insightCount: number;
    duplicateCount: number;
    skippedCount: number;
    summary: string;
    error?: string;
  };

  try {
    // Process the run
    const result = await processInsightExtractionRun(rootDir, input);

    extractionInfo = {
      runAt: input.runAt,
      success: input.stepSuccess,
      insightCount: result.newInsightCount,
      duplicateCount: result.duplicateCount,
      skippedCount: result.insights.length - result.newInsightCount,
      summary: result.summary,
      error: input.error,
    };
  } catch (err) {
    // On processing failure, generate audit with error info
    extractionInfo = {
      runAt: input.runAt,
      success: false,
      insightCount: 0,
      duplicateCount: 0,
      skippedCount: 0,
      summary: `Processing failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Generate the audit report
  const auditReport = await generateMemoryAudit(rootDir, extractionInfo);

  // Write the audit report (best-effort)
  try {
    const auditMarkdown = renderMemoryAuditMarkdown(auditReport);
    await writeMemoryAudit(rootDir, auditMarkdown);
  } catch (err) {
    // Best-effort: log but don't throw
    console.error(
      `[memory-audit] Failed to write audit report: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return auditReport;
}
