/**
 * workflow-integrity operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog, LEGACY_AUTO_MERGE_STAMP_MARKER_KEY, LEGACY_AUTO_MERGE_STAMP_MARKER_VERSION} from "../store.js";
import {readdir, readFile} from "node:fs/promises";
import {join} from "node:path";
import {existsSync} from "node:fs";
import type {AgentLogEntry, CommitAssociationDiffBackfillReport} from "../types.js";
import {workflowHasColumn} from "../workflow-transitions.js";
import {findWorkflowColumn} from "../plugin-gate-verdict.js";
import {getTraitRegistry} from "../trait-registry.js";
import {resolveEntryColumnId} from "../workflow-reconciliation.js";
import "../builtin-traits.js";
import {appendAgentLogEntriesSync} from "../agent-log-file-store.js";
import {truncateAgentLogDetail} from "../agent-log-constants.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import type {CommitAssociationDiffBackfillCandidateRow} from "../task-store/row-types.js";

export async function markLegacyAutoMergeStampsOnceImpl(store: TaskStore): Promise<void> {
    const markerRow = store.db.prepare("SELECT value FROM __meta WHERE key = ?").get(LEGACY_AUTO_MERGE_STAMP_MARKER_KEY) as
      | { value: string }
      | undefined;
    if (markerRow?.value === LEGACY_AUTO_MERGE_STAMP_MARKER_VERSION) {
      return;
    }

    const candidates = await store.listLegacyAutoMergeStampCandidates();
    const markedTaskIds: string[] = [];
    for (const candidate of candidates) {
      const current = await store.getTask(candidate.id);
      if (!current || !store.isLegacyAutoMergeStampCandidate(current)) {
        continue;
      }
      current.autoMergeProvenance = "legacy-stamp";
      current.updatedAt = new Date().toISOString();
      await store.atomicWriteTaskJson(store.taskDir(current.id), current);
      if (store.isWatching) store.taskCache.set(current.id, { ...current });
      store.emitTaskLifecycleEventSafely("task:updated", [current]);
      markedTaskIds.push(current.id);

      void store.recordRunAuditEvent({
        taskId: current.id,
        agentId: "system",
        runId: `legacy-auto-merge-stamp-mark-${current.id}-${Date.now()}`,
        domain: "database",
        mutationType: "task:auto-merge-legacy-stamp-marked",
        target: current.id,
        metadata: {
          taskId: current.id,
          autoMerge: true,
          autoMergeProvenance: "legacy-stamp",
          action: "marked-only-no-behavior-change",
        },
      });
    }

    store.db.prepare(`
      INSERT INTO __meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(LEGACY_AUTO_MERGE_STAMP_MARKER_KEY, LEGACY_AUTO_MERGE_STAMP_MARKER_VERSION);
    store.db.bumpLastModified();

    storeLog.log("legacy auto-merge stamp marker completed", {
      phase: "legacy-auto-merge-stamp-marker",
      markedCount: markedTaskIds.length,
      markedTaskIds: markedTaskIds.slice(0, 50),
      truncated: markedTaskIds.length > 50,
    });
  }

export async function appendAgentLogImpl(store: TaskStore, taskId: string, text: string, type: AgentLogEntry["type"], detail?: string, agent?: AgentLogEntry["agent"],): Promise<void> {
    const timestamp = new Date().toISOString();
    const normalizedDetail = truncateAgentLogDetail(detail, type);
    const entry: AgentLogEntry = {
      timestamp,
      taskId,
      text,
      type,
      ...(normalizedDetail !== undefined && { detail: normalizedDetail }),
      ...(agent !== undefined && { agent }),
    };

    // Buffer the entry for batched insertion to reduce WAL pressure.
    // Drop oldest entries if backlog exceeds hard cap (prolonged outage).
    if (store.agentLogBuffer.length >= TaskStore.MAX_AGENT_LOG_BACKLOG) {
      const dropCount = store.agentLogBuffer.length - TaskStore.MAX_AGENT_LOG_BACKLOG + 1;
      store.agentLogBuffer.splice(0, dropCount);
      // FNXC:PostgresBackend 2026-06-27-00:40:
      // Use the mode-safe `store.fusionDir`, not `store.db.path`: the SQLite
      // getter throws in PG backend mode, and this warning (plus the two
      // flush-failure catch handlers below) runs on the agent-log timer path
      // where an uncaught throw exits the process. The catch blocks exist
      // precisely to keep a failed flush from crashing the caller/process, so
      // they must not themselves dereference `store.db`.
      console.warn(
        `[fusion] Dropped ${dropCount} buffered agent log entries — backlog cap reached (${store.fusionDir})`,
      );
    }
    store.agentLogBuffer.push({
      taskId,
      timestamp,
      text,
      type,
      detail: normalizedDetail ?? null,
      agent: agent ?? null,
    });
    store.emit("agent:log", entry);

    if (store.agentLogBuffer.length >= TaskStore.AGENT_LOG_BUFFER_SIZE) {
      try {
        store.flushAgentLogBuffer();
      } catch (err) {
        // Size-triggered flush failed — log but don't crash the caller.
        console.error(`[fusion] Size-triggered agent log flush failed (${store.fusionDir}):`, err);
      }
    } else if (!store.agentLogFlushTimer) {
      store.agentLogFlushTimer = setTimeout(
        () => {
          try {
            store.flushAgentLogBuffer();
          } catch (err) {
            // Timer-triggered flush failed — log but don't crash the process.
            console.error(`[fusion] Timer-triggered agent log flush failed (${store.fusionDir}):`, err);
          }
        },
        TaskStore.AGENT_LOG_FLUSH_MS,
      );
      store.agentLogFlushTimer.unref();
    }
  }

export async function importLegacyAgentLogsImpl(store: TaskStore): Promise<number> {
    if (!existsSync(store.tasksDir)) return 0;

    const entries = await readdir(store.tasksDir, { withFileTypes: true });
    let imported = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskDir = join(store.tasksDir, entry.name);
      const logPath = join(taskDir, "agent.log");
      if (!existsSync(logPath)) continue;

      try {
        const content = await readFile(logPath, "utf-8");
        const parsedEntries: Array<{
          timestamp: string;
          taskId: string;
          text: string;
          type: AgentLogEntry["type"];
          detail?: string | null;
          agent?: AgentLogEntry["agent"] | null;
        }> = [];
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
            const parsedTaskId = typeof parsed.taskId === "string" ? parsed.taskId : null;
            const type = typeof parsed.type === "string" ? parsed.type : null;
            if (!timestamp || !parsedTaskId || !type) continue;

            parsedEntries.push({
              timestamp,
              taskId: parsedTaskId,
              text: typeof parsed.text === "string" ? parsed.text : "",
              type: type as AgentLogEntry["type"],
              detail: typeof parsed.detail === "string" ? parsed.detail : null,
              agent: typeof parsed.agent === "string" ? (parsed.agent as AgentLogEntry["agent"]) : null,
            });
          } catch {
            // Skip malformed JSONL lines.
          }
        }

        appendAgentLogEntriesSync(taskDir, parsedEntries);
        imported += parsedEntries.length;
      } catch (err) {
        storeLog.warn("Skipping unreadable legacy agent.log file during import", {
          phase: "importLegacyAgentLogs:read-file",
          taskId: entry.name,
          logPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (imported > 0) {
      store.db.bumpLastModified();
    }

    return imported;
  }

export async function cleanupNoOpTaskMovedActivityRowsOnceImpl(store: TaskStore): Promise<void> {
    const migrationKey = "noOpTaskMovedActivityCleanupVersion";
    const migrationVersion = "1";
    const row = store.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;

    if (row?.value === migrationVersion) {
      return;
    }

    const hasTable =
      store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activityLog' LIMIT 1").get() !==
      undefined;
    const markDone = () => {
      store.db.prepare(`
        INSERT INTO __meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(migrationKey, migrationVersion);
    };

    if (!hasTable) {
      markDone();
      store.db.bumpLastModified();
      return;
    }

    store.db.transactionImmediate(() => {
      store.db.prepare(`
        DELETE FROM activityLog
        WHERE type = 'task:moved'
          AND json_extract(metadata, '$.from') = json_extract(metadata, '$.to')
      `).run();
      markDone();
      store.db.bumpLastModified();
    });
  }

export async function runWorkflowColumnsIntegrityPassImpl(store: TaskStore): Promise<{ scanned: number; rehomed: number; skippedTerminal: number }> {
    let scanned = 0;
    let rehomed = 0;
    let skippedTerminal = 0;

    const rows = store.db
      .prepare(`SELECT id FROM tasks WHERE "deletedAt" IS NULL`)
      .all() as Array<{ id: string }>;

    const registry = getTraitRegistry();

    for (const { id } of rows) {
      scanned += 1;
      const task = store.readTaskFromDb(id, { includeDeleted: false });
      if (!task) continue;
      const ir = store.resolveTaskWorkflowIrSync(id);
      const currentColumn = task.column;

      // Already valid in its resolved workflow — nothing to do (the common case;
      // this is why the pass is idempotent and a no-op for healthy DBs).
      if (workflowHasColumn(ir, currentColumn)) continue;

      // The stored column is not in the resolved workflow. Before re-homing,
      // never disturb a terminal card: if the column the card sits in carries a
      // complete/archived flag in its workflow it is terminal — but since the
      // column is NOT in the IR we cannot read its flags there. Fall back to the
      // legacy terminal semantics (done/archived) so terminal cards are never
      // re-homed, matching the plan's "done/archived untouched" rule.
      const column = findWorkflowColumn(ir, currentColumn);
      const flags = column ? registry.resolveColumnFlags(column) : undefined;
      const isTerminal =
        flags?.complete === true ||
        flags?.archived === true ||
        currentColumn === "done" ||
        currentColumn === "archived";
      if (isTerminal) {
        skippedTerminal += 1;
        continue;
      }

      const targetColumn = resolveEntryColumnId(ir);
      if (!targetColumn) continue; // non-reconcilable IR — leave the card put.

      await store.rehomeOccupant(id, targetColumn, "workflow-edit-rehome", {
        integrityPass: true,
        invalidColumn: currentColumn,
      });
      rehomed += 1;
    }

    if (rehomed > 0 || skippedTerminal > 0) {
      storeLog.log("workflowColumns integrity pass completed", {
        phase: "init:workflow-columns-integrity",
        scanned,
        rehomed,
        skippedTerminal,
      });
    }
    return { scanned, rehomed, skippedTerminal };
  }

export async function backfillCommitAssociationDiffStatsImpl(store: TaskStore, options: { dryRun?: boolean } = {},): Promise<CommitAssociationDiffBackfillReport> {
    const dryRun = options.dryRun === true;
    const candidates = store.db.prepare(
      `SELECT commitSha, COUNT(*) AS rowCount
       FROM task_commit_associations
       WHERE additions IS NULL AND deletions IS NULL
       GROUP BY commitSha
       ORDER BY commitSha`,
    ).all() as CommitAssociationDiffBackfillCandidateRow[];

    const report: CommitAssociationDiffBackfillReport = {
      scannedRows: candidates.reduce((sum, row) => sum + row.rowCount, 0),
      distinctCommits: candidates.length,
      updatedRows: 0,
      skippedUnavailableCommits: 0,
      skippedInvalidShas: 0,
      dryRun,
    };

    const validShaPattern = /^[0-9a-fA-F]{7,64}$/;
    const updateStats = store.db.prepare(
      `UPDATE task_commit_associations
       SET additions = ?, deletions = ?, updatedAt = ?
       WHERE commitSha = ? AND additions IS NULL AND deletions IS NULL`,
    );

    for (const candidate of candidates) {
      const commitSha = candidate.commitSha;
      if (!validShaPattern.test(commitSha)) {
        report.skippedInvalidShas += 1;
        continue;
      }

      const verify = await store.runGitCommand(`git cat-file -e ${commitSha}^{commit}`);
      if (verify.exitCode !== 0) {
        report.skippedUnavailableCommits += 1;
        continue;
      }

      const statsResult = await store.runGitCommand(`git show --shortstat --format= ${commitSha}`);
      if (statsResult.exitCode !== 0) {
        report.skippedUnavailableCommits += 1;
        continue;
      }

      const normalized = statsResult.stdout.trim().replace(/\n/g, " ");
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      const additions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      const deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;

      if (dryRun) {
        report.updatedRows += candidate.rowCount;
        continue;
      }

      const result = updateStats.run(additions, deletions, new Date().toISOString(), commitSha);
      report.updatedRows += Number(result.changes);
    }

    return report;
  }

