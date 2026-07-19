import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { sql } from "drizzle-orm";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import type { Routine, RoutineCreateInput } from "./routine.js";

function rowToRoutine(row: Record<string, unknown>): Routine {
  return {
    id: String(row.id), name: String(row.name), description: row.description ? String(row.description) : undefined,
    agentId: String(row.agent_id ?? ""), trigger: row.trigger_config as Routine["trigger"], command: row.command ? String(row.command) : undefined,
    enabled: Number(row.enabled) !== 0, scope: "global", catchUpPolicy: "run_one", executionPolicy: "queue",
    lastRunAt: row.last_run_at ? String(row.last_run_at) : undefined,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : undefined, runCount: Number(row.run_count ?? 0),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), runHistory: (row.run_history as Routine["runHistory"]) ?? [],
  };
}

/**
 * FNXC:SettingsBackups 2026-07-16-16:15:
 * Global routines live in central.global_routines, not project.routines: the latter
 * is partitioned by project_id and would create one schedule per project. The unique
 * name plus transaction advisory lock make the shared-cluster database backup singular.
 */
export class GlobalRoutineStore {
  constructor(private readonly layer: AsyncDataLayer) {}

  async syncBackup(input: Pick<RoutineCreateInput, "name" | "description" | "agentId" | "trigger" | "command" | "enabled">): Promise<Routine> {
    return this.layer.transactionImmediate(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fusion:global-backup-routine'))`);
      const now = new Date().toISOString();
      const id = randomUUID();
      const triggerConfig = input.trigger;
      const nextRunAt = input.trigger.type === "cron"
        ? CronExpressionParser.parse(input.trigger.cronExpression).next().toDate().toISOString()
        : null;
      const rows = await tx.execute(sql`
        INSERT INTO central.global_routines (id, name, description, agent_id, trigger_type, trigger_config, command, enabled, next_run_at, created_at, updated_at)
        VALUES (${id}, ${input.name}, ${input.description ?? null}, ${input.agentId}, ${input.trigger.type}, ${JSON.stringify(triggerConfig)}::jsonb, ${input.command ?? null}, ${input.enabled ? 1 : 0}, ${nextRunAt}, ${now}, ${now})
        ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, agent_id = EXCLUDED.agent_id,
          trigger_type = EXCLUDED.trigger_type, trigger_config = EXCLUDED.trigger_config, command = EXCLUDED.command,
          enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at, updated_at = EXCLUDED.updated_at
        RETURNING *
      `) as unknown as Array<Record<string, unknown>>;
      return rowToRoutine(rows[0]!);
    });
  }

  async deleteByName(name: string): Promise<void> {
    await this.layer.db.execute(sql`DELETE FROM central.global_routines WHERE name = ${name}`);
  }

  async listDue(now = new Date()): Promise<Routine[]> {
    const rows = await this.layer.db.execute(sql`
      SELECT * FROM central.global_routines
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${now.toISOString()}
    `) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRoutine).filter((routine) => routine.trigger.type === "cron");
  }

  /**
   * FNXC:SettingsBackups 2026-07-16-17:00:
   * A due global backup is claimed and advanced in the central row before dispatch.
   * This makes concurrent project engines observe one shared due window, rather than
   * each dumping the PostgreSQL cluster after independently listing the routine.
   */
  async claimDue(id: string, now = new Date()): Promise<Routine | undefined> {
    return this.layer.transactionImmediate(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fusion:global-routine:' || ${id}))`);
      const rows = await tx.execute(sql`
        SELECT * FROM central.global_routines
        WHERE id = ${id} AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${now.toISOString()}
        FOR UPDATE
      `) as unknown as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return undefined;
      const routine = rowToRoutine(row);
      if (routine.trigger.type !== "cron") return undefined;
      const nextRunAt = CronExpressionParser.parse(routine.trigger.cronExpression, { currentDate: now })
        .next().toDate().toISOString();
      await tx.execute(sql`
        UPDATE central.global_routines
        SET last_run_at = ${now.toISOString()}, next_run_at = ${nextRunAt}, updated_at = ${now.toISOString()}
        WHERE id = ${id}
      `);
      return { ...routine, lastRunAt: now.toISOString(), nextRunAt };
    });
  }

  async completeExecution(id: string, result: import("./routine.js").RoutineExecutionResult): Promise<void> {
    await this.layer.transactionImmediate(async (tx) => {
      const rows = await tx.execute(sql`SELECT run_history FROM central.global_routines WHERE id = ${id} FOR UPDATE`) as unknown as Array<Record<string, unknown>>;
      const existing = rows[0];
      if (!existing) return;
      const history = Array.isArray(existing.run_history) ? existing.run_history : [];
      const runHistory = [result, ...history].slice(0, 50);
      await tx.execute(sql`
        UPDATE central.global_routines
        SET last_run_result = ${JSON.stringify(result)}::jsonb, run_history = ${JSON.stringify(runHistory)}::jsonb,
          run_count = run_count + 1, updated_at = ${new Date().toISOString()}
        WHERE id = ${id}
      `);
    });
  }
}
