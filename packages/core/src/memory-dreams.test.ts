import { describe, expect, it, vi } from "vitest";
import {
  createMemoryDreamsAutomation,
  DEFAULT_MEMORY_DREAMS_SCHEDULE,
  MEMORY_DREAMS_SCHEDULE_NAME,
  syncMemoryDreamsAutomation,
} from "./memory-dreams.js";

describe("memory-dreams automation", () => {
  it("creates a scheduled dream processor automation with defaults", () => {
    const automation = createMemoryDreamsAutomation({});

    expect(automation.name).toBe(MEMORY_DREAMS_SCHEDULE_NAME);
    expect(automation.cronExpression).toBe(DEFAULT_MEMORY_DREAMS_SCHEDULE);
    expect(automation.steps).toHaveLength(1);
    expect(automation.steps![0].id).toBe("memory-dream-processor");
    expect(automation.steps![0].prompt).toContain(".fusion/memory/DREAMS.md");
    expect(automation.steps![0].prompt).toContain(".fusion/memory/MEMORY.md");
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
});
