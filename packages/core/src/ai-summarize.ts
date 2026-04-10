/**
 * AI Title Summarization Service
 *
 * Provides AI-powered title generation from task descriptions.
 * Automatically generates concise titles (≤60 characters) from descriptions
 * longer than 200 characters.
 *
 * Features:
 * - Rate limiting per IP (10 requests per hour)
 * - Dynamic import of @fusion/engine for AI agent creation
 * - Text length validation (201-2000 characters)
 */

// Dynamic import for @fusion/engine to avoid resolution issues in test environment
// eslint-disable-next-line @typescript-eslint/consistent-type-imports, @typescript-eslint/no-explicit-any
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

/** System prompt for title summarization */
export const SUMMARIZE_SYSTEM_PROMPT = `You are a title summarization assistant for a task management system.

Your job is to create a concise title (max 60 characters) that summarizes the given task description.

## Guidelines
- Create a clear, descriptive title that captures the essence of what the task is about
- Return only the title text, no quotes, no markdown, no explanations
- The title should be actionable and professional
- Maximum 60 characters — be concise but informative
- Focus on the main goal or deliverable of the task`;

/** Maximum description length in characters */
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Minimum description length for summarization in characters */
export const MIN_DESCRIPTION_LENGTH = 201;

/** Maximum title length in characters */
export const MAX_TITLE_LENGTH = 60;

/** Rate limit: max requests per IP per hour */
export const MAX_REQUESTS_PER_HOUR = 10;

/** Rate limit window in milliseconds (1 hour) */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// ── Rate Limiting ─────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  firstRequestAt: Date;
}

/** Rate limiting state indexed by IP */
const rateLimits = new Map<string, RateLimitEntry>();

/**
 * Check if IP can make a summarization request.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry) {
    // First request from this IP
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Check if window has expired
  if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
    // Reset window
    rateLimits.set(ip, {
      count: 1,
      firstRequestAt: new Date(),
    });
    return true;
  }

  // Within window - check limit
  if (entry.count >= MAX_REQUESTS_PER_HOUR) {
    return false;
  }

  // Increment count
  entry.count++;
  return true;
}

/**
 * Get rate limit reset time for an IP.
 * Returns null if no rate limit entry exists.
 */
export function getRateLimitResetTime(ip: string): Date | null {
  const entry = rateLimits.get(ip);
  if (!entry) return null;

  return new Date(entry.firstRequestAt.getTime() + RATE_LIMIT_WINDOW_MS);
}

/**
 * Remove expired rate limit entries.
 * Runs periodically via setInterval.
 */
function cleanupExpiredRateLimits(): void {
  const now = Date.now();
  let cleanedRateLimits = 0;

  for (const [ip, entry] of rateLimits) {
    if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(ip);
      cleanedRateLimits++;
    }
  }

  if (cleanedRateLimits > 0) {
    console.log(`[ai-summarize] Cleanup: removed ${cleanedRateLimits} rate limit entries`);
  }
}

// Start cleanup interval
const cleanupInterval = setInterval(cleanupExpiredRateLimits, CLEANUP_INTERVAL_MS);

// Handle graceful shutdown
process.on("beforeExit", () => {
  clearInterval(cleanupInterval);
});

// ── Custom Errors ───────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class RateLimitError extends Error {
  resetTime: Date | null;

  constructor(message: string, resetTime: Date | null = null) {
    super(message);
    this.name = "RateLimitError";
    this.resetTime = resetTime;
  }
}

export class AiServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiServiceError";
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate description for summarization.
 * Throws appropriate errors for invalid input.
 */
export function validateDescription(description: unknown): string {
  // Validate description exists
  if (description === undefined || description === null) {
    throw new ValidationError("description is required");
  }

  // Validate description is a string
  if (typeof description !== "string") {
    throw new ValidationError("description must be a string");
  }

  // Validate description length
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `description must be at least ${MIN_DESCRIPTION_LENGTH} characters for summarization`
    );
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `description must not exceed ${MAX_DESCRIPTION_LENGTH} characters`
    );
  }

  return description;
}

// ── AI Integration ───────────────────────────────────────────────────────────

/** Debug flag for AI operations */
const DEBUG = process.env.FUSION_DEBUG_AI === "true";

/**
 * Summarize a task description into a concise title using AI.
 * @param description - The task description to summarize (must be 201-2000 chars)
 * @param rootDir - Project root directory for AI agent context
 * @param provider - Optional AI model provider (e.g., "anthropic")
 * @param modelId - Optional AI model ID (e.g., "claude-sonnet-4-5")
 * @returns The generated title (guaranteed ≤60 characters), or null if validation fails
 */
export async function summarizeTitle(
  description: string,
  rootDir: string,
  provider?: string,
  modelId?: string
): Promise<string | null> {
  // Validate description length first
  if (description.length <= 200) {
    return null; // Too short for summarization
  }

  // Ensure engine is loaded before using createKbAgent
  await engineReady;

  if (!createKbAgent) {
    if (DEBUG) console.log("[ai-summarize] AI engine not available");
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
    systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
    tools: "readonly",
  };

  // Add model selection if both provider and modelId are provided
  if (provider && modelId) {
    agentOptions.defaultProvider = provider;
    agentOptions.defaultModelId = modelId;
  }

  if (DEBUG) console.log("[ai-summarize] Creating agent session...");
  const agentResult = await createKbAgent(agentOptions);

  if (!agentResult?.session) {
    if (DEBUG) console.log("[ai-summarize] Failed to initialize AI agent - no session");
    throw new AiServiceError("Failed to initialize AI agent");
  }

  if (DEBUG) console.log("[ai-summarize] Agent session created, sending prompt...");

  try {
    // Send the description to the agent
    await agentResult.session.prompt(description);

    // Check for session errors (pi SDK stores errors in state.error, does not throw)
    if (agentResult.session.state?.error) {
      const errorMsg = agentResult.session.state.error;
      if (DEBUG) console.log(`[ai-summarize] Session error: ${errorMsg}`);
      throw new AiServiceError(`AI session error: ${errorMsg}`);
    }

    if (DEBUG) console.log("[ai-summarize] Prompt sent, extracting response from messages...");

    // Get the response text from the agent's state
    interface AgentMessage {
      role: string;
      content?: string | Array<{ type: string; text: string }>;
    }

    const messages: AgentMessage[] = agentResult.session.state?.messages ?? [];
    const assistantMessages = messages.filter((m: AgentMessage) => m.role === "assistant");

    if (DEBUG) {
      console.log(`[ai-summarize] Total messages: ${messages.length}, Assistant messages: ${assistantMessages.length}`);
    }

    const lastMessage = assistantMessages.pop();

    let title = "";
    if (lastMessage?.content) {
      // Handle both string and array content types
      if (typeof lastMessage.content === "string") {
        title = lastMessage.content.trim();
      } else if (Array.isArray(lastMessage.content)) {
        // Extract text from content blocks
        title = lastMessage.content
          .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: string; text: string }) => c.text)
          .join("")
          .trim();
      }
    }

    if (DEBUG) console.log(`[ai-summarize] Extracted title: "${title}"`);

    if (!title) {
      if (DEBUG) console.log("[ai-summarize] AI returned empty response");
      throw new AiServiceError("AI returned empty response");
    }

    // Truncate to max title length if needed
    if (title.length > MAX_TITLE_LENGTH) {
      title = title.slice(0, MAX_TITLE_LENGTH).trim();
    }

    if (DEBUG) console.log("[ai-summarize] Title generation successful");
    return title;
  } catch (err) {
    if (err instanceof AiServiceError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : "AI processing failed";
    if (DEBUG) console.log(`[ai-summarize] Unexpected error: ${message}`);
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
 * Reset all summarization state. Used for testing only.
 */
export function __resetSummarizeState(): void {
  rateLimits.clear();
}
