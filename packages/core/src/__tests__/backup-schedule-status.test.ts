import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_SCHEDULE_NAME,
  getBackupScheduleStatus,
  planBackupRoutineSync,
  buildBackupScheduleStatus,
  syncBackupRoutine,
} from "../backup/backup.js";
import { GlobalRoutineStore } from "../automation/global-routine-store.js";
import type { Routine } from "../automation/routine.js";

const schedule = "15 4 * * *";

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "backup-routine",
    name: BACKUP_SCHEDULE_NAME,
    description: "Automatic backup of the shared global PostgreSQL cluster",
    agentId: "",
    trigger: { type: "cron", cronExpression: schedule },
    command: "fn backup --create",
    enabled: true,
    scope: "global",
    catchUpPolicy: "run_one",
    executionPolicy: "queue",
    runCount: 0,
    runHistory: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    nextRunAt: "2026-08-14T04:15:00.000Z",
    ...overrides,
  };
}

const settings = { autoBackupEnabled: true, autoBackupSchedule: schedule } as never;

describe("backup schedule status", () => {
  it.each([
    [{ autoBackupEnabled: false, autoBackupSchedule: schedule }, undefined, "disabled"],
    [{ autoBackupEnabled: true, autoBackupSchedule: schedule }, undefined, "missing"],
    [{ autoBackupEnabled: true, autoBackupSchedule: schedule }, routine({ enabled: false }), "inactive"],
    [{ autoBackupEnabled: true, autoBackupSchedule: schedule }, routine({ trigger: { type: "cron", cronExpression: "0 2 * * *" } }), "mismatched"],
    [{ autoBackupEnabled: true, autoBackupSchedule: schedule }, routine(), "scheduled"],
  ] as const)("maps configuration and routine evidence to %s", (configured, existing, status) => {
    expect(getBackupScheduleStatus(configured as never, existing)).toMatchObject({ status, schedule });
  });
});

describe("backup routine sync planning", () => {
  it("preserves matching cadence and changes only differing routines", () => {
    expect(planBackupRoutineSync(routine(), { trigger: { type: "cron", cronExpression: schedule }, command: "fn backup --create", enabled: true })).toEqual({ action: "none" });
    expect(planBackupRoutineSync(routine(), { trigger: { type: "cron", cronExpression: "0 2 * * *" }, command: "fn backup --create", enabled: true })).toEqual({ action: "upsert" });
    expect(planBackupRoutineSync(routine(), { trigger: { type: "cron", cronExpression: schedule }, command: "fn backup --different", enabled: true })).toEqual({ action: "upsert" });
    expect(planBackupRoutineSync(routine(), { trigger: { type: "cron", cronExpression: schedule }, command: "fn backup --create", enabled: false })).toEqual({ action: "delete" });
    expect(planBackupRoutineSync(undefined, { trigger: { type: "cron", cronExpression: schedule }, command: "fn backup --create", enabled: false })).toEqual({ action: "none" });
  });

  it("maps operator-facing schedule evidence without exposing unbounded output", () => {
    expect(buildBackupScheduleStatus({ autoBackupEnabled: false, autoBackupSchedule: schedule }, undefined)).toMatchObject({ enabled: false, routineRegistered: false, cronExpression: schedule });
    expect(buildBackupScheduleStatus(settings, routine())).toMatchObject({ enabled: true, routineRegistered: true, nextRunAt: "2026-08-14T04:15:00.000Z", runCount: 0 });
    expect(buildBackupScheduleStatus(settings, routine({ lastRunAt: "2026-08-13T04:15:00.000Z", lastRunResult: { routineId: "backup-routine", success: false, output: "failed", error: "disk full", startedAt: "a", completedAt: "b" } }))).toMatchObject({ lastRunSucceeded: false, lastRunOutput: "failed" });
  });
});

describe("backup routine reconciliation", () => {
  it("preserves the project routine next run when its enabled cron is unchanged", async () => {
    const existing = routine({ scope: "project" });
    const updateRoutine = vi.fn();
    const createRoutine = vi.fn();
    const store = {
      asyncLayer: null,
      listRoutines: vi.fn(async () => [existing]),
      updateRoutine,
      createRoutine,
      deleteRoutine: vi.fn(),
    };

    await expect(syncBackupRoutine(store as never, settings)).resolves.toBe(existing);
    expect(updateRoutine).not.toHaveBeenCalled();
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("keeps an enabled global routine cadence in the database upsert", async () => {
    const executed: unknown[] = [];
    const row = {
      id: "backup-routine", name: BACKUP_SCHEDULE_NAME, description: "backup", agent_id: "",
      trigger_config: { type: "cron", cronExpression: schedule }, command: "fn backup --create", enabled: 1,
      next_run_at: "2026-08-14T04:15:00.000Z", created_at: "2026-08-13T00:00:00.000Z",
      updated_at: "2026-08-13T00:00:00.000Z", run_count: 0, run_history: [],
    };
    const layer = {
      transactionImmediate: async (action: (tx: { execute: (query: unknown) => Promise<unknown> }) => Promise<unknown>) => action({
        execute: async (query: unknown) => {
          executed.push(query);
          return executed.length === 1 ? [] : [row];
        },
      }),
      db: { execute: vi.fn() },
    };

    await syncBackupRoutine({ asyncLayer: layer } as never, settings);
    const upsert = JSON.stringify(executed[1]);
    expect(upsert).toContain("global_routines.enabled = 1");
    expect(upsert).toContain("THEN global_routines.next_run_at");
  });

  it("reads the global backup routine by name without enumerating other routines", async () => {
    const execute = vi.fn(async () => [{
      id: "backup-routine", name: BACKUP_SCHEDULE_NAME, description: null, agent_id: "",
      trigger_config: { type: "cron", cronExpression: schedule }, command: "fn backup --create", enabled: 1,
      next_run_at: null, last_run_at: "2026-08-13T04:15:00.000Z",
      last_run_result: { success: true, output: "created", startedAt: "2026-08-13T04:15:00.000Z", completedAt: "2026-08-13T04:16:00.000Z" },
      created_at: "2026-08-13T00:00:00.000Z", updated_at: "2026-08-13T00:00:00.000Z", run_count: 1, run_history: [],
    }]);
    const store = new GlobalRoutineStore({ db: { execute } } as never);

    await expect(store.getByName(BACKUP_SCHEDULE_NAME)).resolves.toMatchObject({
      id: "backup-routine",
      trigger: { type: "cron", cronExpression: schedule },
      lastRunResult: { success: true },
    });
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("WHERE name =");
  });
});
