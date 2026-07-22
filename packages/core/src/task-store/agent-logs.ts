/**
 * agent-logs operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import type {AgentLogEntry, GoalCitationInput} from "../types.js";
import "../builtin-traits.js";
import {appendAgentLogEntriesSync} from "../agents/agent-log-file-store.js";
import {truncateAgentLogDetail} from "../agents/agent-log-constants.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";

export function flushAgentLogBufferImpl(store: TaskStore): void {
    if (store.agentLogFlushTimer) {
      clearTimeout(store.agentLogFlushTimer);
      store.agentLogFlushTimer = null;
    }
    if (store.agentLogBuffer.length === 0) return;

    const batch = store.agentLogBuffer.slice();
    const flushCount = batch.length;

    let validEntries = batch;
    const flushedEntries = new Set<typeof batch[number]>();
    try {
      // FNXC:PostgresBackend 2026-06-27-00:40:
      // In PG backend mode the synchronous SQLite `store.db` getter throws, so
      // the deleted-task pre-filter and the `bumpLastModified` change stamp are
      // skipped. Durability comes from the per-task agent-log.jsonl append below,
      // which is backend-independent. This guard — plus replacing every
      // `store.db.path` log interpolation with the mode-safe `store.fusionDir` —
      // is what stops the retry-flush timer (line ~92) from converting a handled
      // flush error into an UNCAUGHT throw that exits the process in PG mode.
      //
      // Tradeoff (accepted): the SQLite path uses this filter as a SECONDARY net
      // — the primary purge of a deleted task's buffered entries happens at
      // delete time under the task lock (archive-lifecycle.ts:~105), in BOTH
      // backends. The only PG-mode residual is a narrow race (a concurrent
      // append re-buffers after that purge but before this flush): it writes one
      // JSONL line + records goal citations under a just-deleted taskId. There
      // is no FK on goal_citations.task_id (plain text column), so this is an
      // orphaned-by-value metadata row, not a constraint violation or crash.
      if (!store.backendMode) {
        const liveTaskIds = new Set(
          (store.db.prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ id: string }>).map((row) => row.id),
        );
        validEntries = batch.filter((entry) => liveTaskIds.has(entry.taskId));
        const dropped = batch.length - validEntries.length;
        if (dropped > 0) {
          console.warn(
            `[fusion] Dropped ${dropped} buffered agent log entries for deleted tasks (${store.fusionDir})`,
          );
        }
      }

      if (validEntries.length > 0) {
        const citationInputs: GoalCitationInput[] = [];
        const entriesByTask = new Map<string, typeof validEntries>();
        for (const entry of validEntries) {
          const taskEntries = entriesByTask.get(entry.taskId);
          if (taskEntries) {
            taskEntries.push(entry);
          } else {
            entriesByTask.set(entry.taskId, [entry]);
          }
        }

        for (const [taskId, taskEntries] of entriesByTask) {
          const appended = appendAgentLogEntriesSync(store.taskDir(taskId), taskEntries);
          taskEntries.forEach((entry) => flushedEntries.add(entry));
          for (const entry of appended) {
            try {
              citationInputs.push(
                ...store.scanAndRecordCitations(
                  entry.text,
                  "agent_log",
                  entry.sourceRef,
                  entry.agent ?? "unknown",
                  entry.taskId,
                  entry.timestamp,
                ),
              );
            } catch (err) {
              console.warn("[fusion] Failed to scan goal citations from agent_log:", err);
            }
          }
        }

        if (citationInputs.length > 0) {
          // FNXC:PostgresBackend 2026-06-27-00:40:
          // recordGoalCitations is async in PG backend mode, so a sync try/catch
          // cannot catch a rejection — guard the returned promise to keep a
          // citation-write failure from becoming an unhandled rejection on this
          // fire-and-forget agent-log path.
          try {
            void Promise.resolve(store.recordGoalCitations(citationInputs)).catch((err) => {
              console.warn("[fusion] Failed to record goal citations from agent_log batch:", err);
            });
          } catch (err) {
            console.warn("[fusion] Failed to record goal citations from agent_log batch:", err);
          }
        }
        if (!store.backendMode) {
          store.db.bumpLastModified();
        }
      }
    } finally {
      store.agentLogBuffer.splice(0, flushCount);
      const remainingValidEntries = validEntries.filter((entry) => !flushedEntries.has(entry));
      if (remainingValidEntries.length > 0) {
        store.agentLogBuffer.unshift(...remainingValidEntries);
        if (!store.agentLogFlushTimer) {
          store.agentLogFlushTimer = setTimeout(() => {
            try {
              store.flushAgentLogBuffer();
            } catch (err) {
              console.error(`[fusion] Retry agent log flush failed (${store.fusionDir}):`, err);
            }
          }, TaskStore.AGENT_LOG_FLUSH_MS);
          store.agentLogFlushTimer.unref();
        }
      }
    }
  }

export async function appendAgentLogBatchImpl(store: TaskStore, entries: Array<{ taskId: string; text: string; type: AgentLogEntry["type"]; detail?: string; agent?: AgentLogEntry["agent"]; }>,): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    // Flush buffered single-entry appends so they land before batch entries,
    // preserving insertion order (same-timestamp entries are ordered by rowid).
    store.flushAgentLogBuffer();

    const timestamp = new Date().toISOString();
    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      detail: truncateAgentLogDetail(entry.detail, entry.type),
    }));
    // FNXC:PostgresBackend 2026-06-27-00:40:
    // PG backend mode: skip the sync SQLite deleted-task pre-filter (store.db
    // throws) — JSONL append below is the backend-independent durable write.
    // See flushAgentLogBufferImpl for the full rationale.
    let validEntries = normalizedEntries;
    if (!store.backendMode) {
      const liveTaskIds = new Set(
        (store.db.prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ id: string }>).map((row) => row.id),
      );
      validEntries = normalizedEntries.filter((entry) => liveTaskIds.has(entry.taskId));
      const dropped = normalizedEntries.length - validEntries.length;
      if (dropped > 0) {
        console.warn(`[fusion] Dropped ${dropped} batch agent log entries for deleted tasks (${store.fusionDir})`);
      }
    }

    const citationInputs: GoalCitationInput[] = [];
    const entriesByTask = new Map<string, typeof validEntries>();
    for (const entry of validEntries) {
      const taskEntries = entriesByTask.get(entry.taskId);
      if (taskEntries) {
        taskEntries.push(entry);
      } else {
        entriesByTask.set(entry.taskId, [entry]);
      }
    }

    for (const [taskId, taskEntries] of entriesByTask) {
      const appended = appendAgentLogEntriesSync(
        store.taskDir(taskId),
        taskEntries.map((entry) => ({
          timestamp,
          taskId: entry.taskId,
          text: entry.text,
          type: entry.type,
          detail: entry.detail ?? null,
          agent: entry.agent ?? null,
        })),
      );
      for (const entry of appended) {
        try {
          citationInputs.push(
            ...store.scanAndRecordCitations(
              entry.text,
              "agent_log",
              entry.sourceRef,
              entry.agent ?? "unknown",
              entry.taskId,
              entry.timestamp,
            ),
          );
        } catch (err) {
          console.warn("[fusion] Failed to scan goal citations from agent log batch:", err);
        }
      }
    }
    if (citationInputs.length > 0) {
      // FNXC:PostgresBackend 2026-06-27-00:40: async in backend mode — guard the
      // promise so a citation-write failure is not an unhandled rejection.
      try {
        void Promise.resolve(store.recordGoalCitations(citationInputs)).catch((err) => {
          console.warn("[fusion] Failed to record goal citations from appendAgentLogBatch:", err);
        });
      } catch (err) {
        console.warn("[fusion] Failed to record goal citations from appendAgentLogBatch:", err);
      }
    }
    if (validEntries.length > 0 && !store.backendMode) {
      store.db.bumpLastModified();
    }

    for (const entry of normalizedEntries) {
      store.emit("agent:log", {
        timestamp,
        taskId: entry.taskId,
        text: entry.text,
        type: entry.type,
        ...(entry.detail !== undefined && { detail: entry.detail }),
        ...(entry.agent !== undefined && { agent: entry.agent }),
      });
    }
  }

