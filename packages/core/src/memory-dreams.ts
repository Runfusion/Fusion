import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  dailyMemoryPath,
  ensureOpenClawMemoryFiles,
  memoryDreamsPath,
  memoryLongTermPath,
} from "./memory-backend.js";
import type { ScheduledTaskCreateInput } from "./automation.js";
import type { ProjectSettings } from "./types.js";

export const MEMORY_DREAMS_SCHEDULE_NAME = "Memory Dreams";
export const DEFAULT_MEMORY_DREAMS_SCHEDULE = "0 4 * * *";

export interface DreamProcessorResult {
  dreams: string;
  longTermUpdates: string;
}

export type DreamPromptExecutor = (prompt: string) => Promise<string>;

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

export function extractDreamProcessorResult(output: string): DreamProcessorResult {
  const dreamsMatch = output.match(/## DREAMS\s*([\s\S]*?)(?=## LONG_TERM_UPDATES|$)/i);
  const updatesMatch = output.match(/## LONG_TERM_UPDATES\s*([\s\S]*?)$/i);
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

## Rules

- Do not copy task logs or changelog entries into long-term memory.
- Do not invent facts.
- Keep dreams useful for future agents, not a transcript of the day.
- Preserve the three-layer model: daily notes are raw, DREAMS.md is synthesis, MEMORY.md is curated durable knowledge.`;

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
