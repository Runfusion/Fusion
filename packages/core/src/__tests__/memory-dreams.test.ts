import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDailyMemoryPath,
  agentMemoryDreamsPath,
  agentMemoryLongTermPath,
  createMemoryDreamsAutomation,
  DEFAULT_MEMORY_DREAMS_SCHEDULE,
  ensureAgentMemoryFiles,
  extractDreamProcessorResult,
  MEMORY_DREAMS_SCHEDULE_NAME,
  processAgentMemoryDreams,
  syncMemoryDreamsAutomation,
} from "../memory-dreams.js";

describe("extractDreamProcessorResult", () => {
  it("parses dreams and long-term updates from well-formed output", () => {
    const result = extractDreamProcessorResult(
      "## DREAMS\n\nPattern A.\n\n## LONG_TERM_UPDATES\n\n- Lesson A.",
    );
    expect(result).toEqual({
      dreams: "Pattern A.",
      longTermUpdates: "- Lesson A.",
    });
  });

  it("returns empty fields when input is undefined (regression: prompt() returns void)", () => {
    expect(extractDreamProcessorResult(undefined)).toEqual({ dreams: "", longTermUpdates: "" });
    expect(extractDreamProcessorResult(null)).toEqual({ dreams: "", longTermUpdates: "" });
  });

  it("returns empty fields when sections are missing", () => {
    expect(extractDreamProcessorResult("no headings here")).toEqual({ dreams: "", longTermUpdates: "" });
  });
});

describe("memory-dreams automation", () => {
  it("creates a scheduled dream processor automation with defaults", () => {
    const automation = createMemoryDreamsAutomation({});

    expect(automation.name).toBe(MEMORY_DREAMS_SCHEDULE_NAME);
    expect(automation.cronExpression).toBe(DEFAULT_MEMORY_DREAMS_SCHEDULE);
    expect(automation.steps).toHaveLength(1);
    expect(automation.steps![0].id).toBe("memory-dream-processor");
    expect(automation.steps![0].prompt).toContain(".fusion/memory/DREAMS.md");
    expect(automation.steps![0].prompt).toContain(".fusion/memory/MEMORY.md");
    expect(automation.steps![0].prompt).toContain(".fusion/agent-memory/{agentId}/");
    expect(automation.steps![0].prompt).toContain("Keep agent memory separate from workspace memory");
  });

  it("uses custom schedule and model when provided", () => {
    const automation = createMemoryDreamsAutomation(
      { memoryDreamsSchedule: "0 */8 * * *" },
      "anthropic",
      "claude-sonnet-4-5",
    );

    expect(automation.cronExpression).toBe("0 */8 * * *");
    expect(automation.steps![0].modelProvider).toBe("anthropic");
    expect(automation.steps![0].modelId).toBe("claude-sonnet-4-5");
  });

  it("deletes an existing automation when dreams are disabled", async () => {
    const automationStore = {
      listSchedules: vi.fn().mockResolvedValue([{ id: "dreams-1", name: MEMORY_DREAMS_SCHEDULE_NAME }]),
      deleteSchedule: vi.fn().mockResolvedValue(undefined),
    };

    await syncMemoryDreamsAutomation(automationStore as any, { memoryDreamsEnabled: false });

    expect(automationStore.deleteSchedule).toHaveBeenCalledWith("dreams-1");
  });

  it("creates an automation when dreams are enabled", async () => {
    const automationStore = {
      listSchedules: vi.fn().mockResolvedValue([]),
      createSchedule: vi.fn().mockImplementation(async (input) => ({ id: "dreams-1", ...input })),
    };

    const result = await syncMemoryDreamsAutomation(automationStore as any, { memoryDreamsEnabled: true });

    expect(automationStore.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ name: MEMORY_DREAMS_SCHEDULE_NAME }),
    );
    expect(result?.id).toBe("dreams-1");
  });

  it("creates agent long-term, daily, and dreams memory files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-dreams-"));
    try {
      const date = new Date("2026-04-17T12:00:00.000Z");

      await ensureAgentMemoryFiles(rootDir, {
        id: "ceo-agent",
        name: "CEO",
        memory: "Prioritize roadmap sequencing.",
      } as any, date);

      await expect(readFile(agentMemoryLongTermPath(rootDir, "ceo-agent"), "utf-8"))
        .resolves.toContain("Prioritize roadmap sequencing");
      await expect(readFile(agentMemoryDreamsPath(rootDir, "ceo-agent"), "utf-8"))
        .resolves.toContain("Agent Memory Dreams");
      await expect(readFile(agentDailyMemoryPath(rootDir, "ceo-agent", date), "utf-8"))
        .resolves.toContain("Agent Daily Memory 2026-04-17");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("processes agent daily memory into agent dreams and long-term updates", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-dreams-process-"));
    try {
      const date = new Date("2026-04-17T12:00:00.000Z");
      const agent = {
        id: "ceo-agent",
        name: "CEO",
        role: "executor",
        state: "idle",
        memory: "Existing CEO preference.",
        metadata: {},
        createdAt: date.toISOString(),
        updatedAt: date.toISOString(),
      } as any;
      await ensureAgentMemoryFiles(rootDir, agent, date);
      await writeFile(
        agentDailyMemoryPath(rootDir, "ceo-agent", date),
        "# Agent Daily Memory 2026-04-17\n\n- CEO should delegate implementation after sequencing.",
        "utf-8",
      );

      const result = await processAgentMemoryDreams(rootDir, [agent], async (prompt) => {
        expect(prompt).toContain("private memory for agent CEO");
        expect(prompt).toContain("delegate implementation");
        return "## DREAMS\n\nDelegation after sequencing is recurring.\n\n## LONG_TERM_UPDATES\n\n- Delegate implementation after roadmap sequencing.";
      }, date);

      expect(result).toEqual([{
        agentId: "ceo-agent",
        dreams: "Delegation after sequencing is recurring.",
        longTermUpdates: "- Delegate implementation after roadmap sequencing.",
      }]);
      await expect(readFile(agentMemoryDreamsPath(rootDir, "ceo-agent"), "utf-8"))
        .resolves.toContain("Delegation after sequencing is recurring");
      await expect(readFile(agentMemoryLongTermPath(rootDir, "ceo-agent"), "utf-8"))
        .resolves.toContain("Delegate implementation after roadmap sequencing");
      await expect(readFile(agentDailyMemoryPath(rootDir, "ceo-agent", date), "utf-8"))
        .resolves.toContain("Processed into dreams");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
