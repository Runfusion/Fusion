import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, resolve, relative, normalize, sep, dirname } from "node:path";
import {
  readProjectMemory,
  buildMemoryPreSteeringNudge,
  buildPerTurnMemoryRecallCue,
  type Agent,
  type AgentMemoryInclusionMode,
  type AgentRatingSummary,
  type AgentStore,
  type PluginPromptSurface,
  type Settings,
} from "@fusion/core";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import { createLogger } from "../logger.js";
import { readAgentMemoryWorkspaceLongTerm } from "../agent-tools.js";
import { buildMemoryIndex, buildMemoryHeadingIndex } from "./agent-memory-index.js";

const log = createLogger("agent-instructions");

const MAX_INSTRUCTIONS_PATH_LENGTH = 500;
export const MAX_INSTRUCTIONS_TEXT_LENGTH = 50_000;
export const MAX_SOUL_LENGTH = 10_000;
export const MAX_MEMORY_LENGTH = 50_000;

function trimAndClamp(value: string, maxLength: number, label: string, agentId: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  log.warn(`${label} exceeded max length for agent ${agentId}; truncating to ${maxLength} chars`);
  return trimmed.slice(0, maxLength);
}

function isPathTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

function resolveValidatedMarkdownPath(
  rawPath: string,
  rootDir: string,
  agentId: string,
  fieldLabel: string,
): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length > MAX_INSTRUCTIONS_PATH_LENGTH) {
    log.warn(
      `${fieldLabel} too long for agent ${agentId} (${trimmed.length} > ${MAX_INSTRUCTIONS_PATH_LENGTH})`,
    );
    return null;
  }

  if (!trimmed.toLowerCase().endsWith(".md")) {
    log.warn(`${fieldLabel} must end in .md for agent ${agentId}: ${trimmed}`);
    return null;
  }

  if (isAbsolute(trimmed)) {
    log.warn(`${fieldLabel} must be project-relative for agent ${agentId}: ${trimmed}`);
    return null;
  }

  const normalized = normalize(trimmed);
  if (isPathTraversal(normalized)) {
    log.warn(`${fieldLabel} traversal is not allowed for agent ${agentId}: ${trimmed}`);
    return null;
  }

  const resolvedPath = resolve(rootDir, normalized);
  const rel = relative(rootDir, resolvedPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    log.warn(`${fieldLabel} escapes project root for agent ${agentId}: ${trimmed}`);
    return null;
  }

  return resolvedPath;
}

function resolveValidatedInstructionsPath(rawPath: string, rootDir: string, agentId: string): string | null {
  return resolveValidatedMarkdownPath(rawPath, rootDir, agentId, "instructionsPath");
}

/**
 * Load a per-agent heartbeat procedure markdown file. Returns the file
 * contents (trimmed/clamped to MAX_INSTRUCTIONS_TEXT_LENGTH), or null if no
 * path is configured, the path is invalid, or the file is unreadable. Caller
 * substitutes a default constant on null.
 */
export async function resolveAgentHeartbeatProcedure(
  agent: Agent | null | undefined,
  rootDir: string,
): Promise<string | null> {
  const rawPath = agent?.heartbeatProcedurePath?.trim();
  if (!agent || !rawPath) {
    return null;
  }
  const filePath = resolveValidatedMarkdownPath(rawPath, rootDir, agent.id, "heartbeatProcedurePath");
  if (!filePath) {
    return null;
  }
  try {
    const content = await readFile(filePath, "utf-8");
    const normalized = trimAndClamp(
      content,
      MAX_INSTRUCTIONS_TEXT_LENGTH,
      "heartbeat procedure file content",
      agent.id,
    );
    return normalized || null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      log.warn(`Heartbeat procedure file not found for agent ${agent.id}: ${filePath}`);
    } else {
      log.warn(`Failed to read heartbeat procedure file for agent ${agent.id}: ${filePath} (${code})`);
    }
    return null;
  }
}

/**
 * Write the default heartbeat procedure file at `pathRel` (project-relative)
 * if it doesn't already exist. Idempotent: leaves an existing file untouched
 * so operators can edit the procedure without losing their changes on the
 * next upgrade run. Returns the absolute path that was ensured (or null if
 * the path is invalid).
 *
 * The default content is supplied by the caller — kept as a parameter rather
 * than imported from agent-heartbeat.ts to avoid a circular dependency
 * (agent-heartbeat.ts already imports from this module).
 */
export async function ensureDefaultHeartbeatProcedureFile(
  rootDir: string,
  procedurePathRel: string,
  defaultContent: string,
): Promise<string | null> {
  // Reuse the same path validation as the per-agent loader so we never write
  // outside the project root.
  const filePath = resolveValidatedMarkdownPath(procedurePathRel, rootDir, "system", "heartbeatProcedurePath");
  if (!filePath) {
    return null;
  }
  try {
    await access(filePath, fsConstants.F_OK);
    return filePath; // Already exists — preserve operator edits.
  } catch {
    // Falls through to write below.
  }
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, defaultContent, "utf-8");
    log.log(`Seeded default heartbeat procedure file at ${filePath}`);
    return filePath;
  } catch (err: unknown) {
    log.warn(`Failed to seed default heartbeat procedure file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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

function memoryWorkspaceDisplayPath(agentId: string): string {
  const safeAgentId = agentId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `.fusion/agent-memory/${safeAgentId}/MEMORY.md`;
}

async function formatMemorySection(
  memory: string,
  workspaceMemory: string,
  agentId: string,
  rootDir: string,
  inclusionMode: AgentMemoryInclusionMode,
  memoryCapChars?: number,
): Promise<string> {
  if (inclusionMode === "off") {
    return "";
  }

  if (inclusionMode === "index") {
    const indexBody = await buildMemoryIndex({ rootDir, agentId });
    return [
      "## Agent Memory",
      "",
      "Memory is provided in index mode. Use fn_memory_search first, then fn_memory_get for relevant files/lines.",
      buildMemoryPreSteeringNudge("index"),
      ...(indexBody ? ["", indexBody] : []),
    ].join("\n");
  }

  const inlineTrimmed = trimAndClamp(memory, MAX_MEMORY_LENGTH, "memory", agentId);
  const workspaceTrimmed = trimAndClamp(workspaceMemory, MAX_MEMORY_LENGTH, "workspace memory", agentId);
  if (!inlineTrimmed && !workspaceTrimmed) {
    return "";
  }

  /*
  FNXC:ChatContextBudget 2026-08-20-11:56:
  User requirement: agent chat must work on models with a 64K context window.
  The per-agent workspace MEMORY.md can grow past 800K chars (the 50K MAX_MEMORY_LENGTH
  clamp alone is ~14K tokens), which made the chat static context floor exceed the
  128K model window's 80% compaction threshold and dead-end every send with
  ChatContextOverflowError (nothing left for pi compaction to compress). When a
  chat-path budget is set and the combined inline+workspace memory exceeds it, render
  a bounded heading index instead of the full bodies. The full content stays reachable
  via fn_memory_search / fn_memory_get (both the inline memory — synced to the
  workspace file — and the daily/dream files are indexed by the memory backend).
  Engine lanes (triage/executor/reviewer/merger/heartbeat) pass no cap and keep the
  full-mode behavior unchanged.
  */
  if (memoryCapChars != null) {
    const combinedChars = `${inlineTrimmed}\n\n${workspaceTrimmed}`.trim().length;
    if (combinedChars > memoryCapChars) {
      const lines = [
        "## Agent Memory",
        "",
        `Agent memory exceeds this session's ${memoryCapChars}-char context budget, so only a bounded index is inlined. Use fn_memory_search first, then fn_memory_get for the relevant entries, instead of assuming the memory content is present in the prompt.`,
        "",
      ];
      if (workspaceTrimmed) {
        lines.push(
          buildMemoryHeadingIndex({
            sectionHeader: "## Agent Memory Index (use fn_memory_search / fn_memory_get to read)",
            displayPath: memoryWorkspaceDisplayPath(agentId),
            content: workspaceMemory,
            // When inline memory also needs a slice, split the budget 3:1; otherwise
            // the index may take the full budget.
            maxBytes: Math.max(256, Math.floor(memoryCapChars * (inlineTrimmed ? 0.75 : 1))),
          }),
        );
      }
      if (inlineTrimmed) {
        // Budget slice without trimAndClamp's per-turn log warning: this clamp is the
        // intended steady state for chat, not an anomaly.
        const inlineBudget = Math.max(256, Math.floor(memoryCapChars * 0.25));
        lines.push(Buffer.byteLength(inlineTrimmed, "utf8") > inlineBudget ? `${inlineTrimmed.slice(0, inlineBudget)}…` : inlineTrimmed);
      }
      return lines.join("\n");
    }
  }

  const lines = [
    "## Agent Memory",
    "",
    "This is memory for this agent only. Keep it separate from workspace Project Memory; use it for durable preferences, operating habits, and context that should follow this agent across tasks.",
    "Additional daily/dream files under .fusion/agent-memory/{agentId}/ are searchable with fn_memory_search.",
    buildMemoryPreSteeringNudge("full"),
    "",
  ];

  if (inlineTrimmed) {
    lines.push(inlineTrimmed);
  }

  if (workspaceTrimmed) {
    if (!inlineTrimmed) {
      lines.push(`_Source: ${memoryWorkspaceDisplayPath(agentId)}_`, "", workspaceTrimmed);
    } else {
      lines.push("", "### Long-term Workspace Memory", "", workspaceTrimmed);
    }
  }

  return lines.join("\n");
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
  inclusionMode: AgentMemoryInclusionMode = "full",
  memoryCapChars?: number,
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
          log.warn(`Instructions file not found for agent ${agent.id}: ${filePath}`);
        } else {
          log.warn(`Failed to read instructions file for agent ${agent.id}: ${filePath} (${code})`);
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

  const workspaceMemory = await readAgentMemoryWorkspaceLongTerm(rootDir, agent.id);
  const memorySection = await formatMemorySection(
    agent.memory ?? "",
    workspaceMemory,
    agent.id,
    rootDir,
    inclusionMode,
    memoryCapChars,
  );
  if (memorySection) {
    parts.push(memorySection);
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
  inclusionMode: AgentMemoryInclusionMode = "full",
  memoryCapChars?: number,
): Promise<string> {
  if (!agent) {
    return "";
  }

  const baseInstructions = await resolveAgentInstructions(agent, rootDir, undefined, inclusionMode, memoryCapChars);

  if (!agentStore || !agent.id) {
    return baseInstructions;
  }

  try {
    const ratingSummary = await agentStore.getRatingSummary(agent.id);
    return await resolveAgentInstructions(agent, rootDir, ratingSummary, inclusionMode, memoryCapChars);
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
  inclusionMode?: AgentMemoryInclusionMode;
  /**
   * Current-turn topic (last user message / room reply input) used for the B.2
   * per-turn proactive memory recall cue (RUFU-120). Optional — recall is a no-op
   * without it.
   */
  topic?: string;
  /**
   * FNXC:ChatContextBudget 2026-08-20-11:56:
   * Context budget (chars) for the memory sections of the chat system prompt.
   * Dashboard chat passes this so agent + project memory stay bounded on small
   * model windows (user requirement: chat must work on 64K-context models).
   * When a memory source exceeds the budget it is inlined as a heading index;
   * full content stays reachable via fn_memory_search / fn_memory_get.
   * Undefined (engine lanes) keeps the legacy full-injection behavior.
   */
  memoryCapChars?: number;
  /** Stable per-chat session id for the session-scoped recall cue dedup. */
  sessionId?: string;
  /** Project settings for the recall enable/topK/memoryEnabled gates. */
  settings?: Partial<Settings>;
}): Promise<string> {
  const { agent, rootDir, agentStore, basePrompt, includeProjectMemory = false, inclusionMode = "full" } = options;

  const titleSuffix = agent.title?.trim() ? `, ${agent.title.trim()}` : "";
  const identitySection = `## Identity\n\nYou are ${agent.name}${titleSuffix} (agent ID: ${agent.id}, role: ${agent.role}).`;

  const instructionParts = [identitySection];

  const resolvedInstructions = await resolveAgentInstructionsWithRatings(agent, rootDir, agentStore, inclusionMode, options.memoryCapChars);
  if (resolvedInstructions.trim()) {
    instructionParts.push(resolvedInstructions);
  }

  if (includeProjectMemory && inclusionMode !== "off") {
    try {
      const projectMemory = (await readProjectMemory(rootDir)).trim();
      if (projectMemory) {
        /*
        FNXC:ChatContextBudget 2026-08-20-11:56:
        The project long-term memory (.fusion/memory/MEMORY.md) had grown to ~230K chars
        (~65K tokens) and was inlined in full into every agent-bound chat system prompt —
        the dominant component of the static context floor that overflowed the 128K
        window's compaction threshold (ChatContextOverflowError dead-end). With a chat
        budget set, oversized project memory is inlined as a bounded heading index
        instead; the entries stay reachable via fn_memory_search / fn_memory_get. Without
        a budget (engine lanes) the legacy full injection is preserved.
        */
        if (options.memoryCapChars != null && projectMemory.length > options.memoryCapChars) {
          instructionParts.push(
            `## Project Memory\n\n` +
              buildMemoryHeadingIndex({
                sectionHeader: "## Project Memory Index (use fn_memory_search / fn_memory_get to read)",
                displayPath: ".fusion/memory/MEMORY.md",
                content: projectMemory,
                maxBytes: Math.max(512, options.memoryCapChars),
              }) +
              `\n_Project memory exceeds this session's ${options.memoryCapChars}-char context budget; the index above lists what is available. Read the relevant entries with fn_memory_search / fn_memory_get before answering from memory._`,
          );
        } else {
          instructionParts.push(`## Project Memory\n\n${projectMemory}`);
        }
      }
    } catch (error: unknown) {
      // Graceful fallback for chat/heartbeat: if project memory cannot be read,
      // continue with available identity + agent instructions.
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Failed to read project memory for agent ${agent.id}: ${message}`);
    }
  }

  /*
  FNXC:PerTurnMemoryRecall 2026-08-19-01:05:
  RUFU-120 (B.2 LCM phase 2): per-turn proactive memory recall on the chat path. The
  dashboard chat manager rebuilds this system prompt before EVERY turn's LLM call, so a
  bounded, keyword-normalized recall for the current topic (2-3 terms, top-K=3, client-side
  score filter, session-scoped dedup, <=800-char cue under the pre-steering marker) keeps
  the agent focused across long chats — the once-per-session pre-steering nudge alone left
  later turns blind to recent memory. Recall is strictly additive: any failure here (or a
  silent-skip result) degrades to the previous prompt, never to a broken turn.
  */
  if (options.topic?.trim() && inclusionMode !== "off") {
    try {
      const recallCue = await buildPerTurnMemoryRecallCue({
        rootDir,
        topic: options.topic,
        settings: options.settings,
        sessionKey: `chat:${options.sessionId ?? "anonymous"}`,
      });
      if (recallCue) {
        instructionParts.push(`## Memory Recall\n\n${recallCue}`);
      }
    } catch (error: unknown) {
      // Additive recall must never break prompt assembly — log and continue without the cue.
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Per-turn memory recall failed for agent ${agent.id}: ${message}`);
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

export async function buildPluginPromptSection(
  surface: PluginPromptSurface,
  pluginRunner: PluginRunner | undefined,
): Promise<string> {
  if (!pluginRunner) {
    return "";
  }

  const contributions = await pluginRunner.getPromptContributionsForSurface(surface);
  if (contributions.length === 0) {
    return "";
  }

  const prependByPlugin = new Map<string, string[]>();
  const appendByPlugin = new Map<string, string[]>();

  for (const { pluginId, contribution } of contributions) {
    const target = contribution.position === "prepend" ? prependByPlugin : appendByPlugin;
    const existing = target.get(pluginId) ?? [];
    existing.push(contribution.content);
    target.set(pluginId, existing);
  }

  const toSections = (group: Map<string, string[]>): string[] => {
    return Array.from(group.entries()).map(([pluginId, contents]) => {
      return `## Plugin: ${pluginId}\n\n${contents.join("\n\n")}`;
    });
  };

  const sections = [...toSections(prependByPlugin), ...toSections(appendByPlugin)];

  log.log(`Applied ${contributions.length} prompt contributions for surface '${surface}'`);
  return sections.join("\n\n");
}
