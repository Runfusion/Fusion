import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative, normalize, sep } from "node:path";
import {
  readProjectMemory,
  type Agent,
  type AgentRatingSummary,
  type AgentStore,
} from "@fusion/core";

const MAX_INSTRUCTIONS_PATH_LENGTH = 500;
const MAX_INSTRUCTIONS_TEXT_LENGTH = 50_000;
const MAX_SOUL_LENGTH = 10_000;
const MAX_MEMORY_LENGTH = 50_000;

function trimAndClamp(value: string, maxLength: number, label: string, agentId: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  console.warn(
    `[agent-instructions] ${label} exceeded max length for agent ${agentId}; truncating to ${maxLength} chars`,
  );
  return trimmed.slice(0, maxLength);
}

function isPathTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

function resolveValidatedInstructionsPath(rawPath: string, rootDir: string, agentId: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length > MAX_INSTRUCTIONS_PATH_LENGTH) {
    console.warn(
      `[agent-instructions] instructionsPath too long for agent ${agentId} (${trimmed.length} > ${MAX_INSTRUCTIONS_PATH_LENGTH})`,
    );
    return null;
  }

  if (!trimmed.toLowerCase().endsWith(".md")) {
    console.warn(`[agent-instructions] instructionsPath must end in .md for agent ${agentId}: ${trimmed}`);
    return null;
  }

  if (isAbsolute(trimmed)) {
    console.warn(`[agent-instructions] instructionsPath must be project-relative for agent ${agentId}: ${trimmed}`);
    return null;
  }

  const normalized = normalize(trimmed);
  if (isPathTraversal(normalized)) {
    console.warn(`[agent-instructions] instructionsPath traversal is not allowed for agent ${agentId}: ${trimmed}`);
    return null;
  }

  const resolvedPath = resolve(rootDir, normalized);
  const rel = relative(rootDir, resolvedPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    console.warn(`[agent-instructions] instructionsPath escapes project root for agent ${agentId}: ${trimmed}`);
    return null;
  }

  return resolvedPath;
}

function getTrendLabel(trend: AgentRatingSummary["trend"]): string {
  switch (trend) {
    case "improving":
      return "📈 improving";
    case "declining":
      return "📉 declining";
    case "stable":
      return "➡️ stable";
    case "insufficient-data":
    default:
      return "❓ insufficient-data";
  }
}

function formatSoulSection(soul: string, agentId: string): string {
  const trimmed = trimAndClamp(soul, MAX_SOUL_LENGTH, "soul", agentId);
  if (!trimmed) {
    return "";
  }
  return `## Soul\n\n${trimmed}`;
}

function formatMemorySection(memory: string, agentId: string): string {
  const trimmed = trimAndClamp(memory, MAX_MEMORY_LENGTH, "memory", agentId);
  if (!trimmed) {
    return "";
  }
  return `## Memory\n\n${trimmed}`;
}

function formatPerformanceFeedbackSection(ratingSummary: AgentRatingSummary): string {
  const lines: string[] = [
    "## Performance Feedback",
    "",
    `- Average score: ${ratingSummary.averageScore.toFixed(1)}`,
    `- Trend: ${getTrendLabel(ratingSummary.trend)}`,
  ];

  const categoryEntries = Object.entries(ratingSummary.categoryAverages);
  if (categoryEntries.length > 0) {
    lines.push("- Category breakdown:");
    for (const [category, average] of categoryEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  - ${category}: ${average.toFixed(1)}`);
    }
  }

  const recentComments = ratingSummary.recentRatings
    .filter((rating) => typeof rating.comment === "string" && rating.comment.trim().length > 0)
    .slice(0, 3);

  if (recentComments.length > 0) {
    lines.push("- Recent feedback:");
    for (const rating of recentComments) {
      lines.push(`  - "${rating.comment?.trim()}" (score: ${rating.score.toFixed(1)})`);
    }
  }

  return lines.join("\n");
}

/**
 * Resolve custom instructions for an agent by combining inline text and/or
 * file-based instructions.
 *
 * @param agent - The agent record (may contain instructionsText and instructionsPath)
 * @param rootDir - Project root directory for resolving relative paths
 * @returns Concatenated instructions string, or empty string if none
 */
export async function resolveAgentInstructions(
  agent: Agent | null | undefined,
  rootDir: string,
  ratingSummary?: AgentRatingSummary,
): Promise<string> {
  if (!agent) return "";

  const parts: string[] = [];

  // Inline instructions take first position
  if (agent.instructionsText?.trim()) {
    const inline = trimAndClamp(
      agent.instructionsText,
      MAX_INSTRUCTIONS_TEXT_LENGTH,
      "instructionsText",
      agent.id,
    );
    if (inline) {
      parts.push(inline);
    }
  }

  // File-based instructions appended after inline text
  if (agent.instructionsPath?.trim()) {
    const filePath = resolveValidatedInstructionsPath(agent.instructionsPath, rootDir, agent.id);

    if (filePath) {
      try {
        const content = await readFile(filePath, "utf-8");
        const normalizedContent = trimAndClamp(
          content,
          MAX_INSTRUCTIONS_TEXT_LENGTH,
          "instructions file content",
          agent.id,
        );
        if (normalizedContent) {
          parts.push(normalizedContent);
        }
      } catch (err: unknown) {
        // Graceful fallback: file doesn't exist or is unreadable
        // Log a warning but don't throw — instructionsText is still used
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          console.warn(
            `[agent-instructions] Instructions file not found for agent ${agent.id}: ${filePath}`,
          );
        } else {
          console.warn(
            `[agent-instructions] Failed to read instructions file for agent ${agent.id}: ${filePath} (${code})`,
          );
        }
      }
    }
  }

  // Soul/personality section (after instructions, before memory/performance feedback)
  if (agent.soul?.trim()) {
    const soulSection = formatSoulSection(agent.soul, agent.id);
    if (soulSection) {
      parts.push(soulSection);
    }
  }

  if (agent.memory?.trim()) {
    const memorySection = formatMemorySection(agent.memory, agent.id);
    if (memorySection) {
      parts.push(memorySection);
    }
  }

  if (ratingSummary && ratingSummary.totalRatings > 0) {
    parts.push(formatPerformanceFeedbackSection(ratingSummary));
  }

  return parts.join("\n\n");
}

/**
 * Resolve agent instructions and include performance ratings when available.
 * Falls back gracefully to base instructions if ratings lookup fails.
 */
export async function resolveAgentInstructionsWithRatings(
  agent: Agent | null | undefined,
  rootDir: string,
  agentStore: AgentStore | undefined,
): Promise<string> {
  if (!agent) {
    return "";
  }

  const baseInstructions = await resolveAgentInstructions(agent, rootDir);

  if (!agentStore || !agent.id) {
    return baseInstructions;
  }

  try {
    const ratingSummary = await agentStore.getRatingSummary(agent.id);
    return await resolveAgentInstructions(agent, rootDir, ratingSummary);
  } catch {
    return baseInstructions;
  }
}

export async function buildAgentChatPrompt(options: {
  agent: Agent;
  rootDir: string;
  agentStore?: AgentStore;
  basePrompt: string;
  includeProjectMemory?: boolean;
}): Promise<string> {
  const { agent, rootDir, agentStore, basePrompt, includeProjectMemory = false } = options;

  const titleSuffix = agent.title?.trim() ? `, ${agent.title.trim()}` : "";
  const identitySection = `## Identity\n\nYou are ${agent.name}${titleSuffix} (agent ID: ${agent.id}, role: ${agent.role}).`;

  const instructionParts = [identitySection];

  const resolvedInstructions = await resolveAgentInstructionsWithRatings(agent, rootDir, agentStore);
  if (resolvedInstructions.trim()) {
    instructionParts.push(resolvedInstructions);
  }

  if (includeProjectMemory) {
    try {
      const projectMemory = (await readProjectMemory(rootDir)).trim();
      if (projectMemory) {
        instructionParts.push(`## Project Memory\n\n${projectMemory}`);
      }
    } catch (error: unknown) {
      // Graceful fallback for chat/heartbeat: if project memory cannot be read,
      // continue with available identity + agent instructions.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[agent-instructions] Failed to read project memory for agent ${agent.id}: ${message}`);
    }
  }

  return buildSystemPromptWithInstructions(basePrompt, instructionParts.join("\n\n"));
}

/**
 * Append a custom instructions block to a base system prompt.
 * If instructions are empty, returns the base prompt unchanged.
 *
 * @param basePrompt - The original system prompt
 * @param instructions - Resolved instructions string
 * @returns System prompt with instructions appended (if any)
 */
export function buildSystemPromptWithInstructions(
  basePrompt: string,
  instructions: string,
): string {
  if (!instructions.trim()) return basePrompt;
  return `${basePrompt}\n\n## Custom Instructions\n\n${instructions}`;
}
