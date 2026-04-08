import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative, normalize, sep } from "node:path";
import type { Agent } from "@fusion/core";

const MAX_INSTRUCTIONS_PATH_LENGTH = 500;
const MAX_INSTRUCTIONS_TEXT_LENGTH = 50_000;

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

  return parts.join("\n\n");
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
