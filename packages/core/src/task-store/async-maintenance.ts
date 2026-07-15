import { sql } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";

export interface OperationalLogPruneResult {
  deletedByTable: Record<string, number>;
  deletedTotal: number;
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
  const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
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
  await count("usage_events", sql`DELETE FROM project.usage_events WHERE project_id = ${projectId} AND ts < ${cutoff} RETURNING 1`);

  return {
    deletedByTable,
    deletedTotal: Object.values(deletedByTable).reduce((total, value) => total + value, 0),
  };
}
