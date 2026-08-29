/**
 * FNXC:CodeOrganization 2026-08-09-23:30:
 * resolveAuthoritativeExternalExecutionRoute peeled from main executor (U4 / #3398/#3400).
 *
 * FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
 * External checkout routing is durable task state. Long-lived executor callbacks must re-read the matching task row before choosing a checkout so a stale graph snapshot cannot route execution, verification, remediation, or cleanup back to a Fusion-managed worktree.
 */
import type { Task, TaskStore } from "@fusion/core";
import {
  resolveExternalExecutionCheckoutRoute,
  type ExternalExecutionCheckoutResolution,
} from "../execution/external-execution-checkout.js";

export async function resolveAuthoritativeExternalExecutionRoute(
  store: TaskStore,
  task: Task,
): Promise<{ task: Task; route: ExternalExecutionCheckoutResolution }> {
  const live = await store.getTask(task.id).catch(() => null);
  const authoritativeTask = live?.id === task.id ? live : task;
  return {
    task: authoritativeTask,
    route: await resolveExternalExecutionCheckoutRoute(authoritativeTask),
  };
}
