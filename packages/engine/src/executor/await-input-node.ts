/**
 * FNXC:CodeOrganization 2026-08-03-19:50:
 * runAwaitInputNode peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowAskUser 2026-07-05-00:00:
 * FN-7579's `ask-user` node is the first-class discoverable surface over this
 * SAME park/resume plumbing that a `prompt` node with `config.awaitInput: true`
 * already used. Question resolution order: `config.question` (the ask-user
 * node's dedicated field) first, then `config.prompt` (back-compat with the
 * original awaitInput alias), then the shared default string. Nothing below
 * this line branches on node.kind — both node kinds share one pause/resume
 * contract so behavior can never drift between them.
 */
import type { TaskDetail, TaskStore, WorkflowIrNode } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";

export type AwaitInputNodeResult = {
  outcome: "success" | "failure";
  value: string;
  contextPatch?: Record<string, string>;
};

export type AwaitInputNodeDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function runAwaitInputNode(
  deps: AwaitInputNodeDeps,
  node: WorkflowIrNode,
  live: TaskDetail,
): Promise<AwaitInputNodeResult> {
  const question = typeof node.config?.question === "string" && node.config.question.trim()
    ? node.config.question.trim()
    : typeof node.config?.prompt === "string" && node.config.prompt.trim()
      ? node.config.prompt.trim()
      : "This workflow is waiting for your input.";
  const marker = `workflow-input:${node.id}`;

  const steering = Array.isArray(live.steeringComments) ? live.steeringComments : [];
  // Resume only when THIS node previously paused the task (its marker is on
  // pausedReason). A pre-existing steering comment (e.g. one added at task
  // creation) must never short-circuit the pause on the node's first run —
  // otherwise the node consumes a stale comment and never asks the user.
  const pausedReason = live.pausedReason ?? "";
  const pausedByThisNode = pausedReason.startsWith(marker);
  if (!live.paused && pausedByThisNode) {
    // Correlate the reply to THIS pause: the marker embeds a watermark
    // (`${marker}@${pauseEpochMs}: …`) recorded when the node paused. Only
    // count steering comments created at/after that watermark as the answer,
    // so an unpause-without-reply can't consume a comment that predates the
    // pause. The watermark is epoch milliseconds (colon-free) so it never
    // collides with the `:` that separates the marker from the question, nor
    // with the dashboard's colon-delimited question parser.
    const watermark = (() => {
      const m = pausedReason.slice(marker.length).match(/^@(\d+)/);
      const t = m ? Number(m[1]) : NaN;
      return Number.isFinite(t) ? t : undefined;
    })();
    const replies = watermark === undefined
      ? steering
      : steering.filter((c) => {
          const created = Date.parse((c as { createdAt?: string }).createdAt ?? "");
          return Number.isFinite(created) ? created >= watermark : false;
        });
    if (replies.length > 0) {
      // Input has arrived (user replied and unpaused): consume the latest
      // post-pause comment and clear this node's marker so a future fresh
      // visit re-asks instead of silently consuming a stale comment.
      const latest = replies[replies.length - 1] as { text?: string; comment?: string };
      const answer = (latest?.text ?? latest?.comment ?? "").toString();
      await deps.store.updateTask(live.id, { status: null, pausedReason: null }, deps.getRunContextFor(live.id));
      await deps.store.logEntry(live.id, `Workflow input received for node '${node.id}'`, undefined, deps.getRunContextFor(live.id));
      return { outcome: "success", value: "input-received", contextPatch: { [`input:${node.id}`]: answer } };
    }
    // Unpaused but no post-pause reply yet — re-park below and keep waiting.
  }

  await deps.store.logEntry(live.id, `Workflow paused for user input: ${question}`, undefined, deps.getRunContextFor(live.id));
  await deps.store.updateTask(
    live.id,
    { status: "awaiting-user-input", paused: true, pausedReason: `${marker}@${Date.now()}: ${question}` },
    deps.getRunContextFor(live.id),
  );
  // Failure outcome ends the walk; handleGraphFailure leaves paused tasks
  // untouched, so the task sits awaiting input until the user responds.
  return { outcome: "failure", value: "awaiting-user-input" };
}

/**
 * FNXC:CodeOrganization 2026-08-03-19:55:
 * pauseForCliApproval peeled with await-input-node (U4). Dashboard approve + unpause resumes.
 */
export async function pauseForCliApproval(
  deps: AwaitInputNodeDeps,
  node: WorkflowIrNode,
  live: TaskDetail,
  command: string,
): Promise<AwaitInputNodeResult> {
  const marker = `workflow-cli-approval:${node.id}`;
  await deps.store.logEntry(live.id, `Workflow paused for CLI command approval: ${command}`, undefined, deps.getRunContextFor(live.id));
  await deps.store.updateTask(
    live.id,
    { status: "awaiting-cli-approval", paused: true, pausedReason: `${marker}: ${command}` },
    deps.getRunContextFor(live.id),
  );
  return { outcome: "failure", value: "awaiting-cli-approval" };
}
