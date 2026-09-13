import { buildTaskExternalBlockPatch, type TaskStore } from "@fusion/core";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

/** Keep diagnostic prose on the durable task block, never on run-audit metadata. */
export function formatDependencyConfigurationBlockMessage(input: {
  repository: string; command: string; exitCode: number | null; failureCode: string; diagnostic: string;
}): string {
  const diagnostic = input.diagnostic.slice(-280).trim() || "No diagnostic was captured.";
  const result = `${input.repository}: dependency command \`${input.command}\` exited with code ${input.exitCode ?? "unknown"} (${input.failureCode}). ${diagnostic} Set or correct the project worktreeInitCommand, then select Retry.`;
  return result.length <= 600 ? result : `${result.slice(0, 599)}…`;
}

export async function parkDependencyConfigurationBlock(
  deps: Pick<TaskStore, "getTask" | "updateTask" | "logEntry" | "recordRunAuditEvent">,
  input: { taskId: string; repository: string; command: string; exitCode: number | null; failureCode: string; diagnostic: string; nodeId: string; getRunContextFor?: (taskId: string) => unknown },
): Promise<string> {
  const live = await deps.getTask(input.taskId);
  const message = formatDependencyConfigurationBlockMessage(input);
  const externalBlock = {
    origin: "project-configuration" as const, code: input.failureCode, message,
    source: "dependency-readiness" as const, blockedAt: new Date().toISOString(),
    resume: { column: live.column, nodeId: input.nodeId, currentStep: live.currentStep, worktree: live.worktree, branch: live.branch },
  };
  await deps.updateTask(input.taskId, buildTaskExternalBlockPatch(externalBlock));
  await deps.logEntry(input.taskId, `Dependency configuration blocked; correct worktreeInitCommand then Retry: ${input.command}`, undefined, input.getRunContextFor?.(input.taskId) as never);
  await emitBoundedRunAudit(deps, {
    taskId: input.taskId, agentId: "executor", runId: generateSyntheticRunId("dependency-configuration-block", input.taskId),
    domain: "database", mutationType: "task:external-block-parked", target: input.taskId,
    metadata: { taskId: input.taskId, origin: externalBlock.origin, code: externalBlock.code, source: externalBlock.source, column: live.column, resumeNodeId: externalBlock.resume.nodeId },
  });
  return message;
}
