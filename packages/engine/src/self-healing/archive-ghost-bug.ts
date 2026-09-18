/**
 * FNXC:CodeOrganization 2026-08-10-03:45:
 * archiveAsGhostBug peeled from self-healing.ts (U5 / wave19 Slice A).
 */
import { DASHBOARD_USER_ID, type MessageCreateInput, type MessageStore, type TaskStore } from "@fusion/core";
import { resolveArchiveTargetForTask } from "@fusion/core";
import type { GhostBugDecision } from "../triage-domain/triage-preflight.js";
import { createRunAuditor, generateSyntheticRunId } from "../util/run-audit.js";

/**
 * Archive a task whose cited construct is not present on main (ghost bug).
 * #1411: recovery/terminal move — recoveryRehome skips order-derived adjacency
 * so a custom-workflow card can always reach the terminal column.
 *
 * FNXC:GhostBugPreflight 2026-09-17-00:00:
 * A destructive automated triage outcome must be visible outside the archived task row itself — an
 * operator watching the board sees a card vanish from triage with no explanation otherwise. Audit and
 * mailbox delivery are best-effort and detached: a telemetry outage must never delay or block the
 * archive, and the archive must never roll back because a notification failed.
 */
export async function archiveAsGhostBug(
  store: TaskStore,
  taskId: string,
  taskTitle: string,
  decision: GhostBugDecision,
  options: { messageStore?: Pick<MessageStore, "sendMessageOnce"> } = {},
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

  const definitive = decision.findings.filter((finding) => !finding.probeError);
  const missingCount = definitive.filter((finding) => !finding.matched).length;

  /*
  FNXC:GhostBugPreflight 2026-09-17-00:00:
  Detached (not awaited by the archive path) on purpose: even a bounded/fail-soft sink can hang, and
  a planned task must not sit in limbo waiting on best-effort telemetry.
  */
  void Promise.resolve()
    .then(() => createRunAuditor(store, {
      taskId,
      agentId: "triage",
      runId: generateSyntheticRunId("ghost-bug", taskId),
      phase: "triage",
      source: "triage",
    }).database({
      type: "task:auto-archived-ghost-bug-visibility",
      target: taskId,
      metadata: {
        taskId,
        reason: decision.reason,
        constructCount: decision.findings.length,
        definitiveCount: definitive.length,
        missingCount,
        controlOutcome: "matched",
      },
    }))
    .catch(() => undefined);

  if (options.messageStore?.sendMessageOnce) {
    const constructs = decision.findings.map((finding) => `\`${finding.construct.raw}\``).join(", ");
    const message: MessageCreateInput = {
      fromId: "system",
      fromType: "system",
      toId: DASHBOARD_USER_ID,
      toType: "user",
      type: "system",
      content: `**Task ${taskId} was auto-archived as a ghost bug**\n\n${taskTitle || "Untitled task"}\n\nReason: ${decision.reason}\n\nCited constructs: ${constructs || "none"}`,
      metadata: { mailKind: "message", taskId },
    };
    void Promise.resolve()
      .then(() => options.messageStore?.sendMessageOnce(message, `ghost-bug-archive:${taskId}`))
      .catch(() => undefined);
  }

  await store.moveTask(taskId, await resolveArchiveTargetForTask(store, taskId), { moveSource: "engine", recoveryRehome: true });
}
