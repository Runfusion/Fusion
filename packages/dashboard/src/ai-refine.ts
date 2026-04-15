/**
 * AI Text Refinement Service
 *
 * Provides AI-powered text refinement for task descriptions.
 * Supports multiple refinement types: clarify, add-details, expand, simplify.
 *
 * Features:
 * - Rate limiting per IP (10 requests per hour)
 * - Dynamic import of @fusion/engine for AI agent creation
 * - Text length validation (1-2000 characters)
 * - Prompt override support for project-level customization
 */

import type { PromptOverrideMap } from "@fusion/core";
import { resolvePrompt } from "@fusion/core";

// Dynamic import for @fusion/engine to avoid resolution issues in test environment
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

// ── Types ───────────────────────────────────────────────────────────────────

/** Available refinement types */
export type RefinementType = "clarify" | "add-details" | "expand" | "simplify";

/** Valid refinement types for validation */
export const VALID_REFINEMENT_TYPES: RefinementType[] = [
  "clarify",
  "add-details",
  "expand",
  "simplify",
];

/** Request body for text refinement */
export interface RefineTextRequest {
  text: string;
  type: RefinementType;
}

/** Response body for text refinement */
export interface RefineTextResponse {
  refined: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** System prompt for text refinement */
export const REFINE_SYSTEM_PROMPT = `You are a text refinement assistant for a task management system.

Your job is to refine task descriptions based on the user's selected refinement type.

## Refinement Types

1. **clarify**: Make the description clearer and more specific
   - Remove ambiguity
   - Add specific details where vague
   - Ensure the goal is well-defined
   - Keep approximately the same length

2. **add-details**: Add implementation details and context
   - Add technical considerations
   - Include edge cases to consider
   - Mention related files/components if apparent
   - Expand moderately (1.5-2x length)

3. **expand**: Expand into a more comprehensive description
   - Add background context
   - Include acceptance criteria
   - List specific sub-tasks or steps
   - Significantly expand (2-3x length)

4. **simplify**: Simplify and make more concise
   - Remove redundant words
   - Use concise language
   - Keep core meaning intact
   - Reduce length significantly (0.5-0.7x)

## Guidelines
- Maintain the original intent and meaning
- Keep the tone professional and actionable
- Output ONLY the refined text, no markdown formatting, no explanations
- The output should be a direct replacement for the input text`;

/** Maximum text length in characters */
export const MAX_TEXT_LENGTH = 2000;

/** Minimum text length in characters */
export const MIN_TEXT_LENGTH = 1;

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
 * Check if IP can make a refinement request.
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
    console.log(`[ai-refine] Cleanup: removed ${cleanedRateLimits} rate limit entries`);
  }
}

// Start cleanup interval
const cleanupInterval = setInterval(cleanupExpiredRateLimits, CLEANUP_INTERVAL_MS);

// Handle graceful shutdown
process.on("beforeExit", () => {
  clearInterval(cleanupInterval);
});

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate refinement request.
 * Throws appropriate errors for invalid input.
 */
export function validateRefineRequest(
  text: unknown,
  type: unknown
): { text: string; type: RefinementType } {
  // Validate text exists
  if (text === undefined || text === null) {
    throw new ValidationError("text is required");
  }

  // Validate text is a string
  if (typeof text !== "string") {
    throw new ValidationError("text must be a string");
  }

  // Validate text length
  if (text.length < MIN_TEXT_LENGTH) {
    throw new ValidationError(
      `text must be at least ${MIN_TEXT_LENGTH} character${MIN_TEXT_LENGTH === 1 ? "" : "s"}`
    );
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(
      `text must not exceed ${MAX_TEXT_LENGTH} characters`
    );
  }

  // Validate type exists
  if (type === undefined || type === null) {
    throw new ValidationError("type is required");
  }

  // Validate type is a valid refinement type
  if (!VALID_REFINEMENT_TYPES.includes(type as RefinementType)) {
    throw new InvalidTypeError(
      `type must be one of: ${VALID_REFINEMENT_TYPES.join(", ")}`
    );
  }

  return { text, type: type as RefinementType };
}

// ── AI Integration ───────────────────────────────────────────────────────────

/**
 * Refine text using AI agent.
 * @param text - The text to refine
 * @param type - The type of refinement to apply
 * @param rootDir - Project root directory for AI agent context
 * @param promptOverrides - Optional prompt overrides from project settings
 * @returns The refined text
 */
export async function refineText(
  text: string,
  type: RefinementType,
  rootDir: string,
  promptOverrides?: PromptOverrideMap,
): Promise<string> {
  // Ensure engine is loaded before using createKbAgent
  await engineReady;

  if (!createKbAgent) {
    throw new AiServiceError("AI engine not available");
  }

  const effectivePrompt = resolvePrompt("ai-refine-system", promptOverrides);

  const agentResult = await createKbAgent({
    cwd: rootDir,
    systemPrompt: effectivePrompt,
    tools: "readonly",
  });

  if (!agentResult?.session) {
    throw new AiServiceError("Failed to initialize AI agent");
  }

  // Build the prompt with type instruction
  const prompt = `Refinement type: ${type}\n\nText to refine:\n${text}`;

  try {
    // Send message to agent and get response
    await agentResult.session.prompt(prompt);

    // Get the response text from the agent's state
    interface AgentMessage {
      role: string;
      content?: string | Array<{ type: string; text: string }>;
    }
    const lastMessage = (agentResult.session.state.messages as AgentMessage[])
      .filter((m: AgentMessage) => m.role === "assistant")
      .pop();

    let refinedText = "";
    if (lastMessage?.content) {
      // Handle both string and array content types
      if (typeof lastMessage.content === "string") {
        refinedText = lastMessage.content.trim();
      } else if (Array.isArray(lastMessage.content)) {
        // Extract text from content blocks
        refinedText = lastMessage.content
          .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: string; text: string }) => c.text)
          .join("")
          .trim();
      }
    }

    if (!refinedText) {
      throw new AiServiceError("AI returned empty response");
    }

    // Dispose the agent session
    try {
      agentResult.session.dispose?.();
    } catch {
      // Ignore disposal errors
    }

    return refinedText;
  } catch (err) {
    // Ensure session is disposed even on error
    try {
      agentResult.session.dispose?.();
    } catch {
      // Ignore disposal errors
    }

    if (err instanceof AiServiceError) {
      throw err;
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : "AI processing failed"
    );
  }
}

// ── Custom Errors ───────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class InvalidTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTypeError";
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

// ── Test Helpers ───────────────────────────────────────────────────────────

/**
 * Reset all refinement state. Used for testing only.
 */
export function __resetRefineState(): void {
  rateLimits.clear();
}
