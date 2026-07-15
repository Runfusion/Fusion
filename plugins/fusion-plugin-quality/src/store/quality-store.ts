import { randomUUID } from "node:crypto";
import type { Database } from "@fusion/core";
import { isQualityPresetId } from "../runner/command-presets.js";
import type {
  CreateTestPlanInput,
  CreateTestRunInput,
  QualityPresetId,
  SuggestedCase,
  SuggestedCasesSnapshot,
  TestPlan,
  TestPlanStatus,
  TestRun,
  TestRunStatus,
} from "./quality-types.js";

type RunRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  plan_id: string | null;
  source: string;
  preset_id: string | null;
  command: string;
  cwd: string;
  cwd_kind: string;
  status: string;
  exit_code: number | null;
  error_message: string | null;
  timeout_ms: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  stdout: string;
  stderr: string;
  triggered_by: string;
  created_at: string;
  updated_at: string;
};

type PlanRow = {
  id: string;
  project_id: string;
  name: string;
  status: string;
  steps_json: string;
  created_at: string;
  updated_at: string;
};

function mapRun(row: RunRow): TestRun {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id ?? undefined,
    planId: row.plan_id ?? undefined,
    source: row.source as TestRun["source"],
    presetId: (row.preset_id as QualityPresetId | null) ?? undefined,
    command: row.command,
    cwd: row.cwd,
    cwdKind: row.cwd_kind as TestRun["cwdKind"],
    status: row.status as TestRunStatus,
    exitCode: row.exit_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    timeoutMs: row.timeout_ms,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    stdout: row.stdout ?? "",
    stderr: row.stderr ?? "",
    triggeredBy: row.triggered_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlan(row: PlanRow): TestPlan {
  let steps: QualityPresetId[] = [];
  try {
    const parsed = JSON.parse(row.steps_json) as unknown;
    if (Array.isArray(parsed)) {
      steps = parsed.filter(isQualityPresetId);
    }
  } catch {
    steps = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    status: row.status as TestPlanStatus,
    steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class QualityStore {
  constructor(private readonly db: Database) {}

  createRun(input: CreateTestRunInput): TestRun {
    const now = new Date().toISOString();
    const id = `qrun_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO quality_test_runs (
          id, project_id, task_id, plan_id, source, preset_id, command, cwd, cwd_kind,
          status, timeout_ms, stdout, stderr, triggered_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, '', '', ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.planId ?? null,
        input.source,
        input.presetId ?? null,
        input.command,
        input.cwd,
        input.cwdKind,
        input.timeoutMs,
        input.triggeredBy,
        now,
        now,
      );
    return this.getRun(input.projectId, id)!;
  }

  getRun(projectId: string, id: string): TestRun | null {
    const row = this.db
      .prepare(`SELECT * FROM quality_test_runs WHERE id = ? AND project_id = ?`)
      .get(id, projectId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(projectId: string, opts?: { taskId?: string; limit?: number }): TestRun[] {
    const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
    if (opts?.taskId) {
      const rows = this.db
        .prepare(
          `SELECT * FROM quality_test_runs
           WHERE project_id = ? AND task_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(projectId, opts.taskId, limit) as RunRow[];
      return rows.map(mapRun);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM quality_test_runs
         WHERE project_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(projectId, limit) as RunRow[];
    return rows.map(mapRun);
  }

  updateRun(
    projectId: string,
    id: string,
    patch: Partial<{
      status: TestRunStatus;
      exitCode: number | null;
      errorMessage: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      durationMs: number | null;
      stdout: string;
      stderr: string;
    }>,
  ): TestRun | null {
    const existing = this.getRun(projectId, id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE quality_test_runs SET
          status = ?,
          exit_code = ?,
          error_message = ?,
          started_at = ?,
          finished_at = ?,
          duration_ms = ?,
          stdout = ?,
          stderr = ?,
          updated_at = ?
        WHERE id = ? AND project_id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.exitCode !== undefined ? patch.exitCode : (existing.exitCode ?? null),
        patch.errorMessage !== undefined ? patch.errorMessage : (existing.errorMessage ?? null),
        patch.startedAt !== undefined ? patch.startedAt : (existing.startedAt ?? null),
        patch.finishedAt !== undefined ? patch.finishedAt : (existing.finishedAt ?? null),
        patch.durationMs !== undefined ? patch.durationMs : (existing.durationMs ?? null),
        patch.stdout !== undefined ? patch.stdout : existing.stdout,
        patch.stderr !== undefined ? patch.stderr : existing.stderr,
        now,
        id,
        projectId,
      );
    return this.getRun(projectId, id);
  }

  pruneRuns(projectId: string, retention: number): number {
    if (retention <= 0) return 0;
    const result = this.db
      .prepare(
        `DELETE FROM quality_test_runs
         WHERE project_id = ?
           AND status NOT IN ('queued', 'running')
           AND id NOT IN (
             SELECT id FROM quality_test_runs
             WHERE project_id = ? AND status NOT IN ('queued', 'running')
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )`,
      )
      .run(projectId, projectId, retention);
    return Number(result.changes ?? 0);
  }

  findActiveRun(projectId: string, taskId?: string): TestRun | null {
    if (taskId) {
      const row = this.db
        .prepare(
          `SELECT * FROM quality_test_runs
           WHERE project_id = ? AND task_id = ? AND status IN ('queued', 'running')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectId, taskId) as RunRow | undefined;
      return row ? mapRun(row) : null;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM quality_test_runs
         WHERE project_id = ? AND task_id IS NULL AND status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  createPlan(input: CreateTestPlanInput): TestPlan {
    const now = new Date().toISOString();
    const id = `qplan_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO quality_test_plans (id, project_id, name, status, steps_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.name,
        input.status ?? "active",
        JSON.stringify(input.steps),
        now,
        now,
      );
    return this.getPlan(input.projectId, id)!;
  }

  getPlan(projectId: string, id: string): TestPlan | null {
    const row = this.db
      .prepare(`SELECT * FROM quality_test_plans WHERE id = ? AND project_id = ?`)
      .get(id, projectId) as PlanRow | undefined;
    return row ? mapPlan(row) : null;
  }

  listPlans(projectId: string, opts?: { includeArchived?: boolean }): TestPlan[] {
    if (opts?.includeArchived) {
      const rows = this.db
        .prepare(
          `SELECT * FROM quality_test_plans WHERE project_id = ?
           ORDER BY updated_at DESC, id DESC`,
        )
        .all(projectId) as PlanRow[];
      return rows.map(mapPlan);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM quality_test_plans
         WHERE project_id = ? AND status != 'archived'
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(projectId) as PlanRow[];
    return rows.map(mapPlan);
  }

  updatePlan(
    projectId: string,
    id: string,
    patch: Partial<{ name: string; status: TestPlanStatus; steps: QualityPresetId[] }>,
  ): TestPlan | null {
    const existing = this.getPlan(projectId, id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE quality_test_plans SET name = ?, status = ?, steps_json = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        patch.status ?? existing.status,
        JSON.stringify(patch.steps ?? existing.steps),
        now,
        id,
        projectId,
      );
    return this.getPlan(projectId, id);
  }

  getSuggestedCases(projectId: string, taskId: string): SuggestedCasesSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT project_id, task_id, cases_json, generated_at, method
         FROM quality_suggested_cases WHERE project_id = ? AND task_id = ?`,
      )
      .get(projectId, taskId) as
      | {
          project_id: string;
          task_id: string;
          cases_json: string;
          generated_at: string;
          method: string;
        }
      | undefined;
    if (!row) return null;
    let cases: SuggestedCase[] = [];
    try {
      const parsed = JSON.parse(row.cases_json) as unknown;
      if (Array.isArray(parsed)) cases = parsed as SuggestedCase[];
    } catch {
      cases = [];
    }
    return {
      projectId: row.project_id,
      taskId: row.task_id,
      cases,
      generatedAt: row.generated_at,
      method: row.method as SuggestedCasesSnapshot["method"],
    };
  }

  saveSuggestedCases(snapshot: SuggestedCasesSnapshot): SuggestedCasesSnapshot {
    this.db
      .prepare(
        `INSERT INTO quality_suggested_cases (project_id, task_id, cases_json, generated_at, method)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, task_id) DO UPDATE SET
           cases_json = excluded.cases_json,
           generated_at = excluded.generated_at,
           method = excluded.method`,
      )
      .run(
        snapshot.projectId,
        snapshot.taskId,
        JSON.stringify(snapshot.cases),
        snapshot.generatedAt,
        snapshot.method,
      );
    return snapshot;
  }
}
