/**
 * FNXC:CodeOrganization 2026-08-10-03:45:
 * The ghost-bug cleanup helper was peeled from self-healing.ts (U5 / wave19 Slice A).
 */
import { DASHBOARD_USER_ID, type MessageCreateInput, type MessageStore, type TaskStore } from "@fusion/core";
import type { GhostBugDecision } from "../triage-domain/triage-preflight.js";
import { createRunAuditor, generateSyntheticRunId } from "../util/run-audit.js";

/**
 * Soft-delete a task whose cited construct is not present on main (ghost bug).
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-10:36:
 * Ghost work is not completed work. Preserve its reserved identity with a non-resurrectable
 * soft-delete instead of moving it to a removed archive lane.
 *
 * FNXC:GhostBugPreflight 2026-09-07-17:01:
 * A destructive automated triage outcome must be visible outside the deleted task row. Audit and
 * mailbox delivery are best-effort, so telemetry outages cannot delay or prevent the deletion.
 */
export async function softDeleteAsGhostBug(
  store: TaskStore,
  taskId: string,
  decision: GhostBugDecision,
  options: { messageStore?: Pick<MessageStore, "sendMessageOnce">; taskTitle?: string } = {},
): Promise<void> {
  await store.logEntry(
    taskId,
    "Auto-deleted as ghost bug — cited code construct not present on main",
    JSON.stringify({ reason: decision.reason, findings: decision.findings }, null, 2),
  );

  const definitive = decision.findings.filter((finding) => !finding.probeError);
  const missingCount = definitive.filter((finding) => !finding.matched).length;
  /*
   * FNXC:GhostBugPreflight 2026-09-07-17:17:
   * Audit and inbox visibility are detached because even bounded or fail-soft sinks can hang.
   * The destructive decision must complete immediately rather than leave a planned task in limbo.
   */
  void Promise.resolve()
    .then(() => createRunAuditor(store, {
      taskId,
      agentId: "triage",
      runId: generateSyntheticRunId("ghost-bug", taskId),
      phase: "triage",
      source: "triage",
    }).database({
      type: "task:auto-deleted-ghost-bug",
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
      content: `**Task ${taskId} was auto-deleted as a ghost bug**\n\n${options.taskTitle ?? "Untitled task"}\n\nReason: ${decision.reason}\n\nCited constructs: ${constructs || "none"}`,
      metadata: { mailKind: "message", taskId },
    };
    void Promise.resolve()
      .then(() => options.messageStore?.sendMessageOnce(message, `ghost-bug-delete:${taskId}`))
      .catch(() => undefined);
  }

  await store.deleteTask(taskId, { allowResurrection: false });
}
