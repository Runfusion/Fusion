/**
 * FNXC:CodeOrganization 2026-08-10-03:45:
 * archiveAsGhostBug peeled from self-healing.ts (U5 / wave19 Slice A).
 */
import type { TaskStore } from "@fusion/core";
import { resolveArchiveTargetForTask } from "@fusion/core";
import type { GhostBugDecision } from "../triage-domain/triage-preflight.js";

/**
 * Archive a task whose cited construct is not present on main (ghost bug).
 * #1411: recovery/terminal move — recoveryRehome skips order-derived adjacency
 * so a custom-workflow card can always reach the terminal column.
 */
export async function archiveAsGhostBug(
  store: TaskStore,
  taskId: string,
  taskTitle: string,
  decision: GhostBugDecision,
): Promise<void> {
  await store.logEntry(
    taskId,
    "Auto-archived as ghost bug — cited code construct not present on main",
    JSON.stringify({ reason: decision.reason, findings: decision.findings }, null, 2),
  );
  await store.recordActivity({
    type: "task:auto-archived-ghost-bug",
    taskId,
    taskTitle,
    details: "Cited construct not found on main",
    metadata: {
      reason: decision.reason,
      findings: decision.findings.slice(0, 10),
    },
  });
  await store.moveTask(taskId, await resolveArchiveTargetForTask(store, taskId), { moveSource: "engine", recoveryRehome: true });
}
