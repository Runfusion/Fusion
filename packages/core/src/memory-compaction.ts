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
 */

// Dynamic import for @fusion/engine to avoid resolution issues in test environment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createKbAgent: any;

// Initialize the import (this runs in actual server, mocked in tests)
async function initEngine() {
  if (!createKbAgent) {
    try {
      // Use dynamic import with variable to prevent static analysis
      const engineModule = "@fusion/engine";
      const engine = await import(/* @vite-ignore */ engineModule);
      createKbAgent = engine.createKbAgent;
    } catch {
      // Allow failure in test environments - agent functionality will be stubbed
      createKbAgent = undefined;
    }
  }
}

// Initialize on module load (will be awaited in actual usage)
const engineReady = initEngine();

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
  // Ensure engine is loaded before using createKbAgent
  await engineReady;

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

    // Get the response text from the agent's state
    interface AgentMessage {
      role: string;
      content?: string | Array<{ type: string; text: string }>;
    }

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
