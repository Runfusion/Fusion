import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  dailyMemoryPath,
  ensureOpenClawMemoryFiles,
  memoryDreamsPath,
  memoryLongTermPath,
} from "./memory-backend.js";
import type { ScheduledTaskCreateInput } from "./automation.js";
import type { Agent, ProjectSettings } from "./types.js";
import { isEphemeralAgent } from "./types.js";

export const MEMORY_DREAMS_SCHEDULE_NAME = "Memory Dreams";
export const DEFAULT_MEMORY_DREAMS_SCHEDULE = "0 4 * * *";

export interface DreamProcessorResult {
  dreams: string;
  longTermUpdates: string;
}

export interface AgentDreamProcessorResult extends DreamProcessorResult {
  agentId: string;
}

export type DreamPromptExecutor = (prompt: string) => Promise<string>;

const AGENT_MEMORY_ROOT = ".fusion/agent-memory";
const AGENT_MEMORY_FILENAME = "MEMORY.md";
const AGENT_DREAMS_FILENAME = "DREAMS.md";
const DAILY_AGENT_MEMORY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export function agentMemoryWorkspacePath(rootDir: string, agentId: string): string {
  const safeAgentId = agentId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return join(rootDir, AGENT_MEMORY_ROOT, safeAgentId);
}

export function agentMemoryLongTermPath(rootDir: string, agentId: string): string {
  return join(agentMemoryWorkspacePath(rootDir, agentId), AGENT_MEMORY_FILENAME);
}

export function agentMemoryDreamsPath(rootDir: string, agentId: string): string {
  return join(agentMemoryWorkspacePath(rootDir, agentId), AGENT_DREAMS_FILENAME);
}

export function agentDailyMemoryPath(rootDir: string, agentId: string, date = new Date()): string {
  return join(agentMemoryWorkspacePath(rootDir, agentId), `${date.toISOString().slice(0, 10)}.md`);
}

export async function ensureAgentMemoryFiles(rootDir: string, agent: Pick<Agent, "id" | "name" | "memory">, date = new Date()): Promise<void> {
  const workspacePath = agentMemoryWorkspacePath(rootDir, agent.id);
  await mkdir(workspacePath, { recursive: true });

  const longTermPath = agentMemoryLongTermPath(rootDir, agent.id);
  if (!existsSync(longTermPath)) {
    const title = agent.name?.trim() ? `# Agent Memory: ${agent.name.trim()}` : "# Agent Memory";
    await writeFile(
      longTermPath,
      `${title}\n\n<!-- Per-agent memory. Keep separate from workspace Project Memory. -->\n\n${agent.memory?.trim() ?? ""}\n`,
      "utf-8",
    );
  }

  const dreamsPath = agentMemoryDreamsPath(rootDir, agent.id);
  if (!existsSync(dreamsPath)) {
    await writeFile(dreamsPath, "# Agent Memory Dreams\n\n<!-- Synthesized patterns from this agent's daily notes. -->\n", "utf-8");
  }

  const dailyPath = agentDailyMemoryPath(rootDir, agent.id, date);
  if (!existsSync(dailyPath)) {
    await writeFile(dailyPath, `# Agent Daily Memory ${date.toISOString().slice(0, 10)}\n\n<!-- Running observations for this agent. -->\n`, "utf-8");
  }
}

export function buildDreamProcessingPrompt(input: {
  date: string;
  longTermMemory: string;
  dailyMemory: string;
  previousDreams: string;
}): string {
  return `You are processing project memory in an OpenClaw-style memory system.

Read today's daily notes and existing long-term memory. Produce:
1. DREAMS: synthesized patterns, open loops, contradictions, and emerging themes.
2. LONG_TERM_UPDATES: only durable conventions, decisions, pitfalls, or constraints worth keeping.

Rules:
- Do not copy task logs or changelog entries.
- Do not invent facts not present in the input.
- Keep output concise and actionable.
- Return exactly these Markdown headings:

## DREAMS

## LONG_TERM_UPDATES

Date: ${input.date}

## Existing Long-Term Memory

${input.longTermMemory || "(empty)"}

## Previous Dreams

${input.previousDreams || "(empty)"}

## Daily Notes

${input.dailyMemory || "(empty)"}
`;
}

export function extractDreamProcessorResult(output: string | undefined | null): DreamProcessorResult {
  const text = typeof output === "string" ? output : "";
  const dreamsMatch = text.match(/## DREAMS\s*([\s\S]*?)(?=## LONG_TERM_UPDATES|$)/i);
  const updatesMatch = text.match(/## LONG_TERM_UPDATES\s*([\s\S]*?)$/i);
  return {
    dreams: dreamsMatch?.[1]?.trim() ?? "",
    longTermUpdates: updatesMatch?.[1]?.trim() ?? "",
  };
}

async function readIfExists(path: string): Promise<string> {
  if (!existsSync(path)) {
    return "";
  }
  return readFile(path, "utf-8");
}

export async function processMemoryDreams(
  rootDir: string,
  executePrompt: DreamPromptExecutor,
  date = new Date(),
): Promise<DreamProcessorResult> {
  await ensureOpenClawMemoryFiles(rootDir, date);

  const dateKey = date.toISOString().slice(0, 10);
  const longTermPath = memoryLongTermPath(rootDir);
  const dreamsPath = memoryDreamsPath(rootDir);
  const dailyPath = dailyMemoryPath(rootDir, date);

  const prompt = buildDreamProcessingPrompt({
    date: dateKey,
    longTermMemory: await readIfExists(longTermPath),
    previousDreams: await readIfExists(dreamsPath),
    dailyMemory: await readIfExists(dailyPath),
  });

  const result = extractDreamProcessorResult(await executePrompt(prompt));
  if (result.dreams) {
    await appendFile(dreamsPath, `\n## ${dateKey}\n\n${result.dreams}\n`, "utf-8");
  }
  if (result.longTermUpdates) {
    await appendFile(longTermPath, `\n## Dream Updates ${dateKey}\n\n${result.longTermUpdates}\n`, "utf-8");
  }
  await writeFile(dailyPath, `# Daily Memory ${dateKey}\n\n<!-- Processed into dreams on ${new Date().toISOString()} -->\n`, "utf-8");

  return result;
}

async function readAgentDailyNotes(rootDir: string, agentId: string, date: Date): Promise<string> {
  const workspacePath = agentMemoryWorkspacePath(rootDir, agentId);
  const dateKey = date.toISOString().slice(0, 10);
  const dailyPath = agentDailyMemoryPath(rootDir, agentId, date);
  if (existsSync(dailyPath)) {
    return readFile(dailyPath, "utf-8");
  }

  const files = await readdir(workspacePath).catch(() => [] as string[]);
  const chunks: string[] = [];
  for (const file of files) {
    if (!DAILY_AGENT_MEMORY_RE.test(file)) continue;
    if (!file.startsWith(dateKey)) continue;
    const absPath = join(workspacePath, file);
    if ((await stat(absPath)).isFile()) {
      chunks.push(await readFile(absPath, "utf-8"));
    }
  }
  return chunks.join("\n\n");
}

export async function processAgentMemoryDreams(
  rootDir: string,
  agents: Agent[],
  executePrompt: DreamPromptExecutor,
  date = new Date(),
): Promise<AgentDreamProcessorResult[]> {
  const dateKey = date.toISOString().slice(0, 10);
  const results: AgentDreamProcessorResult[] = [];

  for (const agent of agents) {
    if (isEphemeralAgent(agent)) {
      continue;
    }

    await ensureAgentMemoryFiles(rootDir, agent, date);
    const longTermPath = agentMemoryLongTermPath(rootDir, agent.id);
    const dreamsPath = agentMemoryDreamsPath(rootDir, agent.id);
    const dailyPath = agentDailyMemoryPath(rootDir, agent.id, date);

    const prompt = buildDreamProcessingPrompt({
      date: dateKey,
      longTermMemory: await readIfExists(longTermPath),
      previousDreams: await readIfExists(dreamsPath),
      dailyMemory: await readAgentDailyNotes(rootDir, agent.id, date),
    }).replace(
      "You are processing project memory in an OpenClaw-style memory system.",
      `You are processing private memory for agent ${agent.name} (${agent.id}) in an OpenClaw-style memory system.`,
    );

    const result = extractDreamProcessorResult(await executePrompt(prompt));
    if (result.dreams) {
      await appendFile(dreamsPath, `\n## ${dateKey}\n\n${result.dreams}\n`, "utf-8");
    }
    if (result.longTermUpdates) {
      await appendFile(longTermPath, `\n## Dream Updates ${dateKey}\n\n${result.longTermUpdates}\n`, "utf-8");
    }
    await writeFile(dailyPath, `# Agent Daily Memory ${dateKey}\n\n<!-- Processed into dreams on ${new Date().toISOString()} -->\n`, "utf-8");
    results.push({ agentId: agent.id, ...result });
  }

  return results;
}

export function createMemoryDreamsAutomation(
  settings: Partial<ProjectSettings>,
  modelProvider?: string,
  modelId?: string,
): ScheduledTaskCreateInput {
  const schedule = settings.memoryDreamsSchedule ?? DEFAULT_MEMORY_DREAMS_SCHEDULE;
  const prompt = `You are the Memory Dream Processor for an OpenClaw-style project memory system.

## Your Task

1. Read today's daily notes from \`.fusion/memory/YYYY-MM-DD.md\`.
2. Read existing dreams from \`.fusion/memory/DREAMS.md\`.
3. Read long-term memory from \`.fusion/memory/MEMORY.md\`.
4. Append a dated synthesis to \`.fusion/memory/DREAMS.md\` with patterns, open loops, contradictions, and emerging themes.
5. Append only durable conventions, decisions, pitfalls, or constraints to \`.fusion/memory/MEMORY.md\`.
6. Reset today's daily note to a short processed marker after successful synthesis.
7. For every persisted non-ephemeral agent in \`.fusion/agents/*.json\`, repeat the same process for that agent's private memory workspace at \`.fusion/agent-memory/{agentId}/\`:
   - Read \`MEMORY.md\`, \`DREAMS.md\`, and today's \`YYYY-MM-DD.md\`.
   - If the agent workspace is missing, create it and seed \`MEMORY.md\` from the agent JSON \`memory\` field when present.
   - Append agent-specific synthesis to that agent's \`DREAMS.md\`.
   - Promote only durable agent-specific operating preferences, habits, or constraints to that agent's \`MEMORY.md\`.
   - Reset that agent's daily note after successful synthesis.

## Rules

- Do not copy task logs or changelog entries into long-term memory.
- Do not invent facts.
- Keep dreams useful for future agents, not a transcript of the day.
- Preserve the three-layer model for both workspace and agent memory: daily notes are raw, DREAMS.md is synthesis, MEMORY.md is curated durable knowledge.
- Keep agent memory separate from workspace memory. Do not promote private agent operating notes into project memory unless they are useful to every agent in the workspace.`;

  return {
    name: MEMORY_DREAMS_SCHEDULE_NAME,
    description: "Synthesizes daily memory notes into dreams and promotes durable lessons to long-term memory",
    scheduleType: "custom",
    cronExpression: schedule,
    command: "",
    enabled: true,
    steps: [
      {
        id: "memory-dream-processor",
        type: "ai-prompt",
        name: "Process Memory Dreams",
        prompt,
        ...(modelProvider && modelId ? { modelProvider, modelId } : {}),
        timeoutMs: 120_000,
      },
    ],
  };
}

export async function syncMemoryDreamsAutomation(
  automationStore: import("./automation-store.js").AutomationStore,
  settings: Partial<ProjectSettings>,
): Promise<import("./automation.js").ScheduledTask | undefined> {
  const { AutomationStore } = await import("./automation-store.js");
  const schedules = await automationStore.listSchedules();
  const existingSchedule = schedules.find((schedule) => schedule.name === MEMORY_DREAMS_SCHEDULE_NAME);

  if (!settings.memoryDreamsEnabled) {
    if (existingSchedule) {
      await automationStore.deleteSchedule(existingSchedule.id);
    }
    return undefined;
  }

  const schedule = settings.memoryDreamsSchedule ?? DEFAULT_MEMORY_DREAMS_SCHEDULE;
  if (!AutomationStore.isValidCron(schedule)) {
    throw new Error(`Invalid memory dreams schedule: ${schedule}`);
  }

  const input = createMemoryDreamsAutomation(settings);
  if (existingSchedule) {
    return automationStore.updateSchedule(existingSchedule.id, {
      scheduleType: "custom",
      cronExpression: schedule,
      command: input.command,
      steps: input.steps,
      enabled: true,
    });
  }

  return automationStore.createSchedule(input);
}
