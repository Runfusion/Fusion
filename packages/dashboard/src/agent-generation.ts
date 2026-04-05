/**
 * Agent Generation Session Management
 *
 * Manages AI-guided sessions for generating agent specifications from role descriptions.
 * Sessions are stored in-memory with TTL cleanup.
 *
 * Pattern follows planning.ts for consistency.
 *
 * Features:
 * - AI agent integration with streaming via callbacks
 * - Rate limiting per IP
 * - Session expiration and cleanup
 */

import { randomUUID } from "node:crypto";

// Dynamic import for @fusion/engine to avoid resolution issues in test environment
// eslint-disable-next-line @typescript-eslint/consistent-type-imports, @typescript-eslint/no-explicit-any
type AgentResult = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createKbAgent: any;

// Initialize the import (this runs in actual server, mocked in tests)
async function initEngine() {
  if (!createKbAgent) {
    try {
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

/** System prompt for the AI agent that generates agent specifications */
export const AGENT_GENERATION_SYSTEM_PROMPT = `You are an agent specification generator for the kb task board system.

Your job: given a user-provided role description, generate a complete agent specification suitable for creating an AI agent.

## Input
The user will provide a role description like:
- "Senior frontend code reviewer who specializes in React accessibility"
- "Security-focused DevOps engineer"
- "Performance optimization specialist for Node.js applications"

## Output
You MUST respond with ONLY valid JSON (no markdown, no explanation):

{
  "title": "A concise display name (max 60 chars)",
  "icon": "A single emoji representing the agent",
  "role": "The most appropriate capability: triage | executor | reviewer | merger | scheduler | engineer | custom",
  "description": "A brief 1-2 sentence description of the agent's purpose and expertise",
  "systemPrompt": "A detailed markdown system prompt for the agent. This should be comprehensive and include:\\n- Role definition\\n- Core responsibilities\\n- Specific areas of expertise\\n- Behavioral guidelines\\n- Output format expectations\\n- Edge case handling instructions",
  "thinkingLevel": "off | minimal | low | medium | high",
  "maxTurns": 10
}

## Guidelines for System Prompt Generation
- Be specific about the agent's domain expertise
- Include concrete behavioral rules and constraints
- Define the expected output format clearly
- Add error handling and edge case guidance
- Keep the prompt focused and actionable (aim for 200-800 words)
- Use markdown formatting for readability

## Thinking Level Guidelines
- "off": For simple, well-defined tasks (basic CRUD, simple checks)
- "minimal": For straightforward tasks requiring some reasoning
- "low": For moderate complexity tasks
- "medium": For complex analysis, code review, architecture decisions
- "high": For critical decisions, security analysis, complex debugging

## Max Turns Guidelines
- 5-10: Simple, focused tasks (quick reviews, status checks)
- 10-25: Standard tasks (code review, feature planning)
- 25-50: Complex tasks (multi-file changes, architecture analysis)
- 50+: Extended tasks (large refactors, comprehensive audits)

## Role Selection Guidelines
- "reviewer": Agents focused on reviewing, auditing, analyzing
- "executor": Agents that perform implementation work
- "engineer": Agents that do engineering work with broader scope
- "triage": Agents focused on classification and routing
- "custom": Any agent that doesn't fit standard roles
- Default to "custom" if unclear`;

/** Session TTL in milliseconds (30 minutes) */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Max agent generation sessions per IP per hour */
const MAX_SESSIONS_PER_IP_PER_HOUR = 10;

/** Rate limiting window in milliseconds (1 hour) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────────────────

/** Generated agent specification returned by the AI */
export interface AgentGenerationSpec {
  /** Display name for the agent */
  title: string;
  /** Single emoji icon */
  icon: string;
  /** Agent capability/role */
  role: string;
  /** Brief description of the agent's purpose */
  description: string;
  /** Detailed system prompt in markdown */
  systemPrompt: string;
  /** Suggested thinking level */
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  /** Suggested max turns (1-500) */
  maxTurns: number;
}

/** Public state of an agent generation session (no sensitive fields like IP) */
export interface AgentGenerationSession {
  id: string;
  roleDescription: string;
  spec?: AgentGenerationSpec;
  createdAt: Date;
  updatedAt: Date;
}

// ── Internal Types ──────────────────────────────────────────────────────────

interface Session {
  id: string;
  ip: string;
  roleDescription: string;
  spec?: AgentGenerationSpec;
  createdAt: Date;
  updatedAt: Date;
}

interface RateLimitEntry {
  count: number;
  firstRequestAt: Date;
}

// ── In-Memory Storage ───────────────────────────────────────────────────────

/** Active agent generation sessions indexed by session ID */
const sessions = new Map<string, Session>();

/** Rate limiting state indexed by IP */
const rateLimits = new Map<string, RateLimitEntry>();

// ── Cleanup Interval ────────────────────────────────────────────────────────

/**
 * Remove expired sessions and stale rate limit entries.
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleanedSessions = 0;
  let cleanedRateLimits = 0;

  for (const [id, session] of sessions) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      sessions.delete(id);
      cleanedSessions++;
    }
  }

  for (const [ip, entry] of rateLimits) {
    if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(ip);
      cleanedRateLimits++;
    }
  }

  if (cleanedSessions > 0 || cleanedRateLimits > 0) {
    console.log(
      `[agent-generation] Cleanup: removed ${cleanedSessions} sessions, ${cleanedRateLimits} rate limit entries`
    );
  }
}

const cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

process.on("beforeExit", () => {
  clearInterval(cleanupInterval);
});

// ── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Check if IP can create a new agent generation session.
 * Returns true if allowed, false if rate limited.
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry) {
    rateLimits.set(ip, { count: 1, firstRequestAt: new Date() });
    return true;
  }

  if (now - entry.firstRequestAt.getTime() > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, firstRequestAt: new Date() });
    return true;
  }

  if (entry.count >= MAX_SESSIONS_PER_IP_PER_HOUR) {
    return false;
  }

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

// ── JSON Extraction ─────────────────────────────────────────────────────────

/**
 * Extract JSON candidate from AI response text.
 * Handles markdown code blocks and embedded JSON.
 */
function extractJsonCandidate(text: string): string | null {
  if (!text || !text.trim()) return null;

  // 1. Try markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const candidate = codeBlockMatch[1].trim();
    if (candidate.startsWith("{")) return candidate;
  }

  // 2. Find balanced brace-delimited objects
  const candidates: Array<{ text: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1).trim();
          try {
            JSON.parse(candidate);
            candidates.push({ text: candidate });
          } catch {
            // Not valid JSON, skip
          }
          break;
        }
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.text.length - a.text.length);
    return candidates[0].text;
  }

  // 3. Last resort: try the full trimmed text
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;

  return null;
}

/**
 * Attempt to repair common JSON issues (truncated, trailing commas, etc.).
 */
function repairJson(text: string): string {
  let repaired = text;
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  if (inString) repaired += '"';

  // Re-count after potential string fix
  openBraces = 0;
  openBrackets = 0;
  inString = false;
  escape = false;
  for (const ch of repaired) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  repaired += "]".repeat(Math.max(0, openBrackets));
  repaired += "}".repeat(Math.max(0, openBraces));

  return repaired;
}

/**
 * Parse the AI response text into an AgentGenerationSpec.
 */
export function parseGenerationResponse(text: string): AgentGenerationSpec {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    throw new Error("AI returned no valid JSON. Please try again.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      const repaired = repairJson(candidate);
      parsed = JSON.parse(repaired);
    } catch (repairErr) {
      throw new Error(
        `Failed to parse AI response: ${repairErr instanceof Error ? repairErr.message : "Unknown error"}. Please try again.`
      );
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("AI returned an invalid response structure. Please try again.");
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required fields with defaults
  return {
    title: typeof obj.title === "string" ? obj.title.slice(0, 60) : "Custom Agent",
    icon: typeof obj.icon === "string" ? obj.icon : "🤖",
    role: typeof obj.role === "string" ? obj.role : "custom",
    description: typeof obj.description === "string" ? obj.description : "",
    systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : "",
    thinkingLevel: ["off", "minimal", "low", "medium", "high"].includes(obj.thinkingLevel as string)
      ? (obj.thinkingLevel as AgentGenerationSpec["thinkingLevel"])
      : "off",
    maxTurns: typeof obj.maxTurns === "number"
      ? Math.max(1, Math.min(500, Math.round(obj.maxTurns)))
      : 10,
  };
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Start a new agent generation session.
 * Creates the session in memory but does not yet generate the spec.
 * Call `generateAgentSpec()` to trigger AI generation.
 *
 * @param ip - Client IP for rate limiting
 * @param roleDescription - The user's description of the desired agent role
 * @returns Session object (without spec — call generateAgentSpec to populate)
 */
export async function startAgentGeneration(
  ip: string,
  roleDescription: string,
): Promise<AgentGenerationSession> {
  if (!checkRateLimit(ip)) {
    const resetTime = getRateLimitResetTime(ip);
    throw new RateLimitError(
      `Rate limit exceeded. Maximum ${MAX_SESSIONS_PER_IP_PER_HOUR} generation sessions per hour. ` +
      `Reset at ${resetTime?.toISOString() || "unknown"}`
    );
  }

  const sessionId = randomUUID();
  const session: Session = {
    id: sessionId,
    ip,
    roleDescription,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  sessions.set(sessionId, session);

  return toPublicSession(session);
}

/**
 * Generate the agent specification for an existing session using AI.
 * This calls the AI model with the session's role description and populates
 * the session's spec field.
 *
 * @param sessionId - The session identifier
 * @param rootDir - Project root directory for AI agent context
 * @returns The generated agent specification
 */
export async function generateAgentSpec(
  sessionId: string,
  rootDir: string
): Promise<AgentGenerationSpec> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SessionNotFoundError(`Agent generation session ${sessionId} not found or expired`);
  }

  try {
    await engineReady;
    const spec = await generateSpecWithAI(session, rootDir);
    session.spec = spec;
    session.updatedAt = new Date();
    return spec;
  } catch (err) {
    console.error(`[agent-generation] AI generation failed for session ${sessionId}:`, err);
    throw err;
  }
}

/**
 * Generate an agent specification using the AI agent.
 */
async function generateSpecWithAI(session: Session, rootDir: string): Promise<AgentGenerationSpec> {
  if (!createKbAgent) {
    throw new Error("AI agent not available. Ensure the engine is properly configured.");
  }

  const agent = await createKbAgent({
    cwd: rootDir,
    systemPrompt: AGENT_GENERATION_SYSTEM_PROMPT,
    tools: "none",
  });

  try {
    await agent.session.prompt(
      `Generate an agent specification for the following role:\n\n${session.roleDescription}`
    );

    // Extract response text
    interface AgentMessage {
      role: string;
      content?: string | Array<{ type: string; text: string }>;
    }
    const lastMessage = (agent.session.state.messages as AgentMessage[])
      .filter((m: AgentMessage) => m.role === "assistant")
      .pop();

    let responseText = "";
    if (lastMessage?.content) {
      if (typeof lastMessage.content === "string") {
        responseText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        responseText = lastMessage.content
          .filter((c: { type: string; text: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { type: string; text: string }) => c.text)
          .join("");
      }
    }

    return parseGenerationResponse(responseText);
  } finally {
    try {
      agent.session.dispose?.();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get a session by ID.
 *
 * @param sessionId - The session identifier
 * @returns The session, or undefined if not found
 */
export function getAgentGenerationSession(sessionId: string): AgentGenerationSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return toPublicSession(session);
}

/**
 * Clean up and remove a session.
 *
 * @param sessionId - The session identifier
 */
export function cleanupAgentGenerationSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Convert internal session to public session type.
 */
function toPublicSession(session: Session): AgentGenerationSession {
  return {
    id: session.id,
    roleDescription: session.roleDescription,
    spec: session.spec,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * Reset all agent generation state. Used for testing only.
 */
export function __resetAgentGenerationState(): void {
  sessions.clear();
  rateLimits.clear();
}

// ── Custom Errors ───────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}
