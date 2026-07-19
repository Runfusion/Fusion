import { sql } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { pruneAgentLogFiles as pruneAgentLogFileEntries } from "../agent-log-file-store.js";

export interface OperationalLogPruneResult {
  deletedByTable: Record<string, number>;
  deletedTotal: number;
}

/**
 * Prune per-task agent-log JSONL files for tasks that are no longer active,
 * against the PostgreSQL backend.
 *
 * FNXC:PostgresOnlyDataAccess 2026-07-17-14:20:
 * The sync `pruneAgentLogFilesImpl` reads inactive task ids via `store.db`,
 * which throws the removed-SQLite stub in backend mode. The self-healing
 * maintenance sweep (`prune-agent-log-files`) called it unguarded, so every PG
 * sweep with retention enabled threw and agent-log pruning never ran. This
 * async variant is the PostgreSQL equivalent: it reads the inactive task ids
 * (`deleted_at IS NOT NULL OR column = 'archived'`, project-scoped) from
 * `project.tasks` and delegates the file pruning to the shared helper. Query
 * semantics mirror the SQLite path exactly.
 */
export async function pruneAgentLogFilesAsync(
  layer: AsyncDataLayer,
  tasksDir: string,
  retentionDays: number,
): Promise<{ prunedFiles: number; prunedEntries: number; freedBytes: number }> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { prunedFiles: 0, prunedEntries: 0, freedBytes: 0 };
  }
  const boundProjectId = layer.projectId?.trim();
  if (!boundProjectId) {
    console.warn("[fusion] PostgreSQL agent-log-file pruning is using the legacy unscoped project sentinel because asyncLayer.projectId is missing");
  }
  const projectId = boundProjectId || "__legacy_unscoped__";
  const rows = (await layer.db.execute(
    sql`SELECT id FROM project.tasks WHERE project_id = ${projectId} AND (deleted_at IS NOT NULL OR "column" = 'archived')`,
  )) as unknown as Array<{ id: string }>;
  const inactiveTaskIds = new Set(rows.map((row) => row.id));
  return pruneAgentLogFileEntries(tasksDir, retentionDays, inactiveTaskIds);
}

/**
 * Delete project-scoped operational history older than the retention cutoff.
 *
 * FNXC:PostgresRetention 2026-07-14-17:16:
 * PostgreSQL autovacuum reclaims deleted tuples but does not enforce product
 * retention. Apply the same bounded-history policy as the former local store,
 * explicitly partitioned by project, and always retain each agent's newest
 * configuration revision.
 */
export async function pruneOperationalLogsAsync(
  layer: AsyncDataLayer,
  retentionMs: number,
): Promise<OperationalLogPruneResult> {
  const deletedByTable: Record<string, number> = {};
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    return { deletedByTable, deletedTotal: 0 };
  }
  const boundProjectId = layer.projectId?.trim();
  /*
  FNXC:PostgresRetention 2026-07-14-21:55:
  Operational retention should normally be project-bound. Preserve the legacy sentinel fallback for compatibility, but make every unbound maintenance pass visible before it can target legacy-unscoped rows.
  */
  if (!boundProjectId) {
    console.warn("[fusion] PostgreSQL operational maintenance is using the legacy unscoped project sentinel because asyncLayer.projectId is missing");
  }
  const projectId = boundProjectId || "__legacy_unscoped__";
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const count = async (name: string, statement: ReturnType<typeof sql>): Promise<void> => {
    const rows = await layer.db.execute(sql`WITH deleted AS (${statement}) SELECT count(*)::int AS count FROM deleted`) as unknown as Array<{ count: number | string }>;
    deletedByTable[name] = Number(rows[0]?.count ?? 0);
  };

  /*
  FNXC:PostgresRetentionPerformance 2026-07-14-17:50:
  Retention reports one aggregate count per table. The database counts deleted tuples inside a CTE so maintenance never transfers or materializes every deleted primary key in application memory.
  */
  await count("activityLog", sql`DELETE FROM project.activity_log WHERE project_id = ${projectId} AND timestamp < ${cutoff} RETURNING 1`);
  /*
  FNXC:PostgresRetention 2026-07-14-18:12:
  Legacy run-audit and heartbeat rows do not carry project_id. Scope deletion through their owning task/agent instead; taskless audit rows remain retained because their project cannot be proven, which is safer than cross-project deletion.
  */
  await count("runAuditEvents", sql`
    DELETE FROM project.run_audit_events AS events
    WHERE events.timestamp < ${cutoff}
      AND events.task_id IN (
        SELECT id FROM project.tasks WHERE project_id = ${projectId}
      )
    RETURNING 1
  `);
  await count("agentHeartbeats", sql`
    DELETE FROM project.agent_heartbeats AS heartbeats
    WHERE heartbeats.timestamp < ${cutoff}
      AND heartbeats.project_id = ${projectId}
      AND heartbeats.agent_id IN (
        SELECT id FROM project.agents WHERE project_id = ${projectId}
      )
    RETURNING 1
  `);
  await count("agentRuns", sql`DELETE FROM project.agent_runs WHERE project_id = ${projectId} AND ended_at IS NOT NULL AND ended_at < ${cutoff} RETURNING 1`);
  await count("agentConfigRevisions", sql`
    DELETE FROM project.agent_config_revisions AS revisions
    WHERE revisions.project_id = ${projectId}
      AND revisions.created_at < ${cutoff}
      AND revisions.id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC, id DESC) AS row_number
          FROM project.agent_config_revisions
          WHERE project_id = ${projectId}
        ) ranked
        WHERE row_number = 1
      )
    RETURNING 1
  `);
  await count("usageEvents", sql`DELETE FROM project.usage_events WHERE project_id = ${projectId} AND ts < ${cutoff} RETURNING 1`);

  return {
    deletedByTable,
    deletedTotal: Object.values(deletedByTable).reduce((total, value) => total + value, 0),
  };
}
