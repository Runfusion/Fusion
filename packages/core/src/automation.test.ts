import { describe, expect, it } from "vitest";
import { CronExpressionParser } from "cron-parser";
import {
  AUTOMATION_PRESETS,
  MAX_RUN_HISTORY,
  type AutomationRunResult,
  type AutomationStep,
  type AutomationStepResult,
  type ScheduleType,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
} from "./automation.js";

const expectedPresetMap = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 1",
  monthly: "0 0 1 * *",
  every15Minutes: "*/15 * * * *",
  every30Minutes: "*/30 * * * *",
  every2Hours: "0 */2 * * *",
  every6Hours: "0 */6 * * *",
  every12Hours: "0 */12 * * *",
  weekdays: "0 9 * * 1-5",
} as const;

const expectedPresetKeys = Object.keys(expectedPresetMap) as Array<Exclude<ScheduleType, "custom">>;

const allScheduleTypesRecord: Record<ScheduleType, true> = {
  hourly: true,
  daily: true,
  weekly: true,
  monthly: true,
  custom: true,
  every15Minutes: true,
  every30Minutes: true,
  every2Hours: true,
  every6Hours: true,
  every12Hours: true,
  weekdays: true,
};

const allScheduleTypes = Object.keys(allScheduleTypesRecord) as ScheduleType[];
const CRON_TIMEZONE = "UTC";

function cronDateToDate(value: { toISOString(): string | null; getTime(): number }): Date {
  const iso = value.toISOString();
  return iso ? new Date(iso) : new Date(value.getTime());
}

function parseNextRun(cronExpression: string, currentDate?: Date): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: currentDate ?? new Date(),
    tz: CRON_TIMEZONE,
  });
  return cronDateToDate(interval.next());
}

function createPresetInput(scheduleType: Exclude<ScheduleType, "custom">): ScheduledTaskCreateInput {
  return {
    name: `Preset ${scheduleType}`,
    command: "echo test",
    scheduleType,
  };
}

function isValidCreateInput(input: ScheduledTaskCreateInput): boolean {
  if (!input.name.trim() || !input.command.trim()) {
    return false;
  }

  if (!allScheduleTypes.includes(input.scheduleType)) {
    return false;
  }

  if (input.scheduleType === "custom") {
    return Boolean(input.cronExpression?.trim());
  }

  return true;
}

describe("AUTOMATION_PRESETS", () => {
  it("contains every preset key except custom", () => {
    const presetKeys = Object.keys(AUTOMATION_PRESETS).sort();
    expect(presetKeys).toEqual([...expectedPresetKeys].sort());
  });

  it("contains valid 5-field cron expressions", () => {
    for (const [scheduleType, cronExpression] of Object.entries(AUTOMATION_PRESETS)) {
      expect(cronExpression).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
      expect(() => CronExpressionParser.parse(cronExpression)).not.toThrow();
      expect(scheduleType).toBeTruthy();
    }
  });

  it("maps each preset key to the expected cron expression", () => {
    expect(AUTOMATION_PRESETS).toEqual(expectedPresetMap);
  });

  it("does not include a custom preset", () => {
    expect((AUTOMATION_PRESETS as Record<string, string | undefined>).custom).toBeUndefined();
  });
});

describe("ScheduleType", () => {
  it("treats all preset keys as valid ScheduleType values", () => {
    const presetKeys = Object.keys(AUTOMATION_PRESETS) as Array<Exclude<ScheduleType, "custom">>;
    expect(presetKeys.every((key) => allScheduleTypes.includes(key))).toBe(true);
  });

  it("includes custom in ScheduleType but not in AUTOMATION_PRESETS", () => {
    expect(allScheduleTypes).toContain("custom");
    expect(Object.prototype.hasOwnProperty.call(AUTOMATION_PRESETS, "custom")).toBe(false);
  });
});

describe("MAX_RUN_HISTORY", () => {
  it("is set to 50", () => {
    expect(MAX_RUN_HISTORY).toBe(50);
  });

  it("is a positive integer", () => {
    expect(Number.isInteger(MAX_RUN_HISTORY) && MAX_RUN_HISTORY > 0).toBe(true);
  });

  it("is a finite number", () => {
    expect(Number.isFinite(MAX_RUN_HISTORY)).toBe(true);
  });
});

describe("Interface contracts with AutomationStore", () => {
  it("accepts every non-custom preset scheduleType in ScheduledTaskCreateInput", () => {
    const inputs = expectedPresetKeys.map((scheduleType) => createPresetInput(scheduleType));

    expect(inputs).toHaveLength(expectedPresetKeys.length);
    expect(inputs.every(isValidCreateInput)).toBe(true);
  });

  it("supports custom ScheduledTaskCreateInput with explicit cronExpression", () => {
    const customInput: ScheduledTaskCreateInput = {
      name: "Custom schedule",
      command: "echo custom",
      scheduleType: "custom",
      cronExpression: "*/10 * * * *",
    };

    expect(customInput.scheduleType).toBe("custom");
    expect(customInput.cronExpression).toBe("*/10 * * * *");
    expect(isValidCreateInput(customInput)).toBe(true);
  });

  it("supports AutomationStep command shape", () => {
    const commandStep: AutomationStep = {
      id: "step-command-1",
      type: "command",
      name: "Run command",
      command: "echo hello",
    };

    expect(commandStep).toMatchObject({
      id: "step-command-1",
      type: "command",
      name: "Run command",
      command: "echo hello",
    });
  });

  it("supports AutomationStep ai-prompt shape", () => {
    const aiPromptStep: AutomationStep = {
      id: "step-ai-1",
      type: "ai-prompt",
      name: "Analyze output",
      prompt: "Summarize the latest run output",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    };

    expect(aiPromptStep).toMatchObject({
      id: "step-ai-1",
      type: "ai-prompt",
      name: "Analyze output",
      prompt: "Summarize the latest run output",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("supports successful AutomationRunResult shape", () => {
    const runResult: AutomationRunResult = {
      success: true,
      output: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    };

    expect(runResult).toMatchObject({
      success: true,
      output: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("supports failed AutomationRunResult shape with error", () => {
    const runResult: AutomationRunResult = {
      success: false,
      output: "",
      error: "Command failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    };

    expect(runResult.success).toBe(false);
    expect(runResult.error).toBe("Command failed");
  });

  it("supports AutomationStepResult required shape", () => {
    const stepResult: AutomationStepResult = {
      stepId: "step-1",
      stepName: "Run command",
      stepIndex: 0,
      success: true,
      output: "done",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    };

    expect(stepResult).toMatchObject({
      stepId: "step-1",
      stepName: "Run command",
      stepIndex: 0,
      success: true,
      output: "done",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("supports full ScheduledTask shape", () => {
    const fullTask: ScheduledTask = {
      id: "schedule-1",
      name: "Nightly build",
      scheduleType: "daily",
      cronExpression: "0 0 * * *",
      command: "pnpm build",
      enabled: true,
      runCount: 3,
      runHistory: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      description: "Run nightly build",
      lastRunAt: "2026-01-02T00:00:00.000Z",
      lastRunResult: {
        success: true,
        output: "ok",
        startedAt: "2026-01-02T00:00:00.000Z",
        completedAt: "2026-01-02T00:01:00.000Z",
      },
      nextRunAt: "2026-01-03T00:00:00.000Z",
      timeoutMs: 300000,
      steps: [
        {
          id: "step-1",
          type: "command",
          name: "Build",
          command: "pnpm build",
        },
      ],
      currentStepIndex: 0,
    };

    expect(fullTask).toMatchObject({
      id: "schedule-1",
      name: "Nightly build",
      scheduleType: "daily",
      cronExpression: "0 0 * * *",
      command: "pnpm build",
      enabled: true,
      runCount: 3,
      runHistory: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("Preset cron expression edge cases", () => {
  it("ensures weekdays preset never schedules Saturday or Sunday in the next 7 runs", () => {
    const interval = CronExpressionParser.parse(AUTOMATION_PRESETS.weekdays, {
      currentDate: new Date("2026-04-06T00:00:00.000Z"), // Monday
      tz: CRON_TIMEZONE,
    });

    const days = Array.from({ length: 7 }, () => cronDateToDate(interval.next()).getUTCDay());
    expect(days.every((day) => day !== 0 && day !== 6)).toBe(true);
  });

  it("ensures monthly preset runs on day 1", () => {
    const nextRun = parseNextRun(AUTOMATION_PRESETS.monthly, new Date("2026-04-15T00:00:00.000Z"));
    expect(nextRun.getUTCDate()).toBe(1);
  });

  it("ensures every15Minutes preset advances in 15 minute intervals", () => {
    const interval = CronExpressionParser.parse(AUTOMATION_PRESETS.every15Minutes, {
      currentDate: new Date("2026-01-01T00:00:00.000Z"),
      tz: CRON_TIMEZONE,
    });

    const first = cronDateToDate(interval.next());
    const second = cronDateToDate(interval.next());
    const third = cronDateToDate(interval.next());

    expect(second.getTime() - first.getTime()).toBe(15 * 60 * 1000);
    expect(third.getTime() - second.getTime()).toBe(15 * 60 * 1000);
  });

  it("ensures every2Hours preset advances in 2 hour intervals", () => {
    const interval = CronExpressionParser.parse(AUTOMATION_PRESETS.every2Hours, {
      currentDate: new Date("2026-01-01T00:00:00.000Z"),
      tz: CRON_TIMEZONE,
    });

    const first = cronDateToDate(interval.next());
    const second = cronDateToDate(interval.next());
    const third = cronDateToDate(interval.next());

    expect(second.getTime() - first.getTime()).toBe(2 * 60 * 60 * 1000);
    expect(third.getTime() - second.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it("ensures each preset computes a next run in the future", () => {
    const now = new Date();

    for (const cronExpression of Object.values(AUTOMATION_PRESETS)) {
      const nextRun = parseNextRun(cronExpression, now);
      expect(nextRun.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
