/**
 * AI Memory Compaction Service
 *
 * Provides AI-powered memory compaction for project memory files.
 * Uses an AI agent to distill memory content down to the most important
 * architectural conventions, pitfalls, and decisions.
 *
 * Features:
 * - Dynamic import of @fusion/engine for AI agent creation
 * - Read-only tool access (prevents accidental memory modification during compaction)
 * - Session disposal in finally block to prevent leaks
 * - AiServiceError for AI-related failures
 * - Auto-summarize automation integration for scheduled compaction
 */

import type { ProjectSettings } from "./types.js";
import type { ScheduledTaskCreateInput } from "./automation.js";
import { getKbAgent, type AgentMessage } from "./ai-engine-loader.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** System prompt for memory compaction */
export const COMPACT_MEMORY_SYSTEM_PROMPT = `You are a memory distillation assistant for a software development project.

Your job is to compress the provided project memory markdown into a shorter version that preserves only the most important information.

## Guidelines
- Preserve only the most important architectural conventions and patterns
- Preserve critical pitfalls and anti-patterns to avoid
- Preserve significant decisions and their rationale
- Remove redundant examples, outdated information, and trivial details
- Maintain the markdown format and structure
- Output ONLY the compacted markdown - no explanations or commentary
- Be aggressive in trimming while keeping essential knowledge

## What to KEEP:
- Key architectural patterns and their rationale
- Important conventions that agents must follow
- Critical pitfalls and how to avoid them
- Major project decisions and their context
- Security-sensitive patterns

## What to REMOVE:
- Verbose examples that can be inferred
- Minor implementation details
- Outdated or superseded information
- Repetitive explanations
- Trivial gotchas that aren't critical

Return only the compacted markdown content.`;

/** Debug flag for AI operations */
const DEBUG = process.env.FUSION_DEBUG_AI === "true";

// ── Custom Errors ───────────────────────────────────────────────────────────

export class AiServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiServiceError";
  }
}

// ── AI Integration ───────────────────────────────────────────────────────────

/**
 * Compact memory content using AI to distill it down to the most important insights.
 *
 * @param content - The current memory content to compact
 * @param rootDir - Project root directory for AI agent context
 * @param provider - Optional AI model provider (e.g., "anthropic")
 * @param modelId - Optional AI model ID (e.g., "claude-sonnet-4-5")
 * @returns The compacted memory content
 * @throws AiServiceError if AI processing fails
 */
export async function compactMemoryWithAi(
  content: string,
  rootDir: string,
  provider?: string,
  modelId?: string
): Promise<string> {
  const createKbAgent = await getKbAgent();
  if (!createKbAgent) {
    if (DEBUG) console.log("[memory-compaction] AI engine not available");
    throw new AiServiceError("AI engine not available");
  }

  const agentOptions: {
    cwd: string;
    systemPrompt: string;
    tools: "readonly";
    defaultProvider?: string;
    defaultModelId?: string;
  } = {
    cwd: rootDir,
    systemPrompt: COMPACT_MEMORY_SYSTEM_PROMPT,
    tools: "readonly",
  };

  // Add model selection if both provider and modelId are provided
  if (provider && modelId) {
    agentOptions.defaultProvider = provider;
    agentOptions.defaultModelId = modelId;
  }

  if (DEBUG) console.log("[memory-compaction] Creating agent session...");
  const agentResult = await createKbAgent(agentOptions);

  if (!agentResult?.session) {
    if (DEBUG) console.log("[memory-compaction] Failed to initialize AI agent - no session");
    throw new AiServiceError("Failed to initialize AI agent");
  }

  if (DEBUG) console.log("[memory-compaction] Agent session created, sending prompt...");

  try {
    // Send the memory content to the agent
    await agentResult.session.prompt(content);

    // Check for session errors (pi SDK stores errors in state.error, does not throw)
    if (agentResult.session.state?.error) {
      const errorMsg = agentResult.session.state.error;
      if (DEBUG) console.log(`[memory-compaction] Session error: ${errorMsg}`);
      throw new AiServiceError(`AI session error: ${errorMsg}`);
    }

    if (DEBUG) console.log("[memory-compaction] Prompt sent, extracting response from messages...");

    const messages: AgentMessage[] = agentResult.session.state?.messages ?? [];
    const assistantMessages = messages.filter((m: AgentMessage) => m.role === "assistant");

    if (DEBUG) {
      console.log(`[memory-compaction] Total messages: ${messages.length}, Assistant messages: ${assistantMessages.length}`);
    }

    const lastMessage = assistantMessages.pop();

    let compacted = "";
    if (lastMessage?.content) {
      // Handle both string and array content types
      if (typeof lastMessage.content === "string") {
        compacted = lastMessage.content.trim();
      } else if (Array.isArray(lastMessage.content)) {
        // Extract text from content blocks
        compacted = lastMessage.content
          .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: string; text: string }) => c.text)
          .join("")
          .trim();
      }
    }

    if (DEBUG) console.log(`[memory-compaction] Extracted compacted content length: ${compacted.length}`);

    if (!compacted) {
      if (DEBUG) console.log("[memory-compaction] AI returned empty response");
      throw new AiServiceError("AI returned empty response");
    }

    if (DEBUG) console.log("[memory-compaction] Memory compaction successful");
    return compacted;
  } catch (err) {
    if (err instanceof AiServiceError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : "AI processing failed";
    if (DEBUG) console.log(`[memory-compaction] Unexpected error: ${message}`);
    throw new AiServiceError(message);
  } finally {
    // Ensure session is disposed even on error
    try {
      agentResult.session.dispose?.();
    } catch {
      // Ignore disposal errors
    }
  }
}

// ── Test Helpers ───────────────────────────────────────────────────────────

/**
 * Reset all compaction state. Used for testing only.
 * Currently a no-op since there are no caches, but available for future use.
 */
export function __resetCompactionState(): void {
  // No-op: no caches to reset in current implementation
}

// ── Automation Integration ───────────────────────────────────────────────

/** Constant name for the auto-summarize automation schedule. */
export const AUTO_SUMMARIZE_SCHEDULE_NAME = "Memory Auto-Summarize";

/** Default schedule for auto-summarize: daily at 3 AM. */
export const DEFAULT_AUTO_SUMMARIZE_SCHEDULE = "0 3 * * *";

/**
 * Create the automation config for auto-summarize memory compaction.
 *
 * Returns a `ScheduledTaskCreateInput` ready for `AutomationStore.createSchedule()`.
 * The automation uses a single `ai-prompt` step that checks memory size and
 * compacts it if it exceeds the configured threshold.
 *
 * The AI model provider and ID are optional — when not specified, the
 * automation system falls back to the project's default model.
 *
 * @param settings - Project settings for schedule and threshold configuration.
 * @param modelProvider - Optional AI model provider override.
 * @param modelId - Optional AI model ID override.
 * @returns The automation creation input.
 */
export function createAutoSummarizeAutomation(
  settings: Partial<ProjectSettings>,
  modelProvider?: string,
  modelId?: string,
): ScheduledTaskCreateInput {
  const schedule = settings.memoryAutoSummarizeSchedule ?? DEFAULT_AUTO_SUMMARIZE_SCHEDULE;
  const threshold = settings.memoryAutoSummarizeThresholdChars ?? 50_000;

  // Build the prompt that reads working memory, checks size, and compacts if needed.
  // Note: At automation execution time, the AI agent has access to the filesystem.
  const prompt = `You are the Memory Auto-Summarization agent. Your job is to check the project's working memory file size and compress it when it exceeds the configured threshold.

## Your Task

1. Read the working memory file at \`.fusion/memory/MEMORY.md\` using your file reading tools
2. Check if the file size exceeds the threshold of ${threshold} characters
3. If the file is BELOW the threshold: output JSON indicating no compaction needed:
   \`\`\`json
   {"skipped": true, "reason": "Below threshold", "currentSize": <actual_size>}
   \`\`\`
4. If the file is AT OR ABOVE the threshold:
   a) Distill the memory to ONLY the most important insights
   b) Preserve at least 2 of these 3 core sections: Architecture, Conventions, Pitfalls
   c) Write the compacted content back to \`.fusion/memory/MEMORY.md\`
   d) Output JSON indicating compaction was done:
   \`\`\`json
   {"skipped": false, "originalSize": <size_before>, "newSize": <size_after>, "reduction": "<percentage>%"}
   \`\`\`

## Compaction Guidelines

**MUST PRESERVE (durable items):**
- Architecture: Project structure, key abstractions, major components
- Conventions: Coding standards, naming patterns, established practices
- Pitfalls: Known issues to avoid, anti-patterns to watch for
- Any section header (## <name>) should stay if it contains durable content

**SHOULD REMOVE (transient items):**
- One-time observations from completed tasks
- Task-specific implementation notes
- Verbose explanations that can be condensed
- Outdated or superseded entries
- Trivial gotchas that aren't critical

**CRITICAL REQUIREMENTS:**
- You MUST preserve at least 2 of these 3 core sections: Architecture, Conventions, Pitfalls
- Output ONLY valid JSON — no markdown fences, no extra text
- Use your file writing tools to update \`.fusion/memory/MEMORY.md\` with the compacted content`;

  return {
    name: AUTO_SUMMARIZE_SCHEDULE_NAME,
    description: "Automatically compresses working memory when it exceeds the configured size threshold",
    scheduleType: "custom",
    cronExpression: schedule,
    command: "", // Required by type but unused when steps are present
    enabled: true,
    steps: [
      {
        id: "memory-auto-summarize",
        type: "ai-prompt",
        name: "Auto-Summarize Memory",
        prompt,
        ...(modelProvider && modelId ? { modelProvider, modelId } : {}),
        timeoutMs: 120_000, // 2 minutes
      },
    ],
  };
}

/**
 * Synchronize the auto-summarize automation with project settings.
 *
 * Creates, updates, or deletes the automation schedule based on whether
 * auto-summarize is enabled in the project settings. Follows the same
 * pattern as `syncInsightExtractionAutomation()`.
 *
 * @param automationStore - The AutomationStore instance.
 * @param settings - Current project settings.
 * @returns The created/updated schedule, or undefined if deleted/disabled.
 */
export async function syncAutoSummarizeAutomation(
  automationStore: import("./automation-store.js").AutomationStore,
  settings: Partial<ProjectSettings>,
): Promise<import("./automation.js").ScheduledTask | undefined> {
  const { AutomationStore } = await import("./automation-store.js");

  // Find existing auto-summarize schedule by name
  const schedules = await automationStore.listSchedules();
  const existingSchedule = schedules.find(
    (s) => s.name === AUTO_SUMMARIZE_SCHEDULE_NAME,
  );

  // If auto-summarize is disabled, delete existing schedule if present
  if (!settings.memoryAutoSummarizeEnabled) {
    if (existingSchedule) {
      await automationStore.deleteSchedule(existingSchedule.id);
    }
    return undefined;
  }

  // Validate the cron schedule
  const schedule = settings.memoryAutoSummarizeSchedule ?? DEFAULT_AUTO_SUMMARIZE_SCHEDULE;
  if (!AutomationStore.isValidCron(schedule)) {
    throw new Error(`Invalid auto-summarize schedule: ${schedule}`);
  }

  // Build the automation input
  const input = createAutoSummarizeAutomation(settings);

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
