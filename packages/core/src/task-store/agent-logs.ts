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
import {appendAgentLogEntriesSync} from "../agent-log-file-store.js";
import {truncateAgentLogDetail} from "../agent-log-constants.js";
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
      const liveTaskIds = new Set(
        (store.db.prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ id: string }>).map((row) => row.id),
      );
      validEntries = batch.filter((entry) => liveTaskIds.has(entry.taskId));
      const dropped = batch.length - validEntries.length;
      if (dropped > 0) {
        console.warn(
          `[fusion] Dropped ${dropped} buffered agent log entries for deleted tasks (${store.db.path})`,
        );
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
          try {
            store.recordGoalCitations(citationInputs);
          } catch (err) {
            console.warn("[fusion] Failed to record goal citations from agent_log batch:", err);
          }
        }
        store.db.bumpLastModified();
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
              console.error(`[fusion] Retry agent log flush failed (${store.db.path}):`, err);
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
    const liveTaskIds = new Set(
      (store.db.prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ id: string }>).map((row) => row.id),
    );
    const validEntries = normalizedEntries.filter((entry) => liveTaskIds.has(entry.taskId));
    const dropped = normalizedEntries.length - validEntries.length;
    if (dropped > 0) {
      console.warn(`[fusion] Dropped ${dropped} batch agent log entries for deleted tasks (${store.db.path})`);
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
      try {
        store.recordGoalCitations(citationInputs);
      } catch (err) {
        console.warn("[fusion] Failed to record goal citations from appendAgentLogBatch:", err);
      }
    }
    if (validEntries.length > 0) {
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

