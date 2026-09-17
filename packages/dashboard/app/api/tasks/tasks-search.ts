/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 AI task-search client. The browser sends only the operator's phrase: it never selects a
 * model, a lane, or a candidate set — those belong to the server's Fast & Cheap resolution.
 *
 * When the operator is viewing a REMOTE node the request is routed through that node's proxy. There
 * is deliberately no local fallback: answering a remote search with local results would show another
 * project's tasks under the remote node's identity.
 */
import type { Task } from "@fusion/core";
import { proxyApi } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import {
  AI_TASK_SEARCH_CLIENT_TIMEOUT_MS,
  type AiTaskSearchResponse,
} from "../../../src/shared/task-search";

export interface AiTaskSearchOptions {
  projectId?: string;
  nodeId?: string;
  localNodeId?: string;
  signal?: AbortSignal;
}

/**
 * Run one AI task search. Resolves with the server's echoed query plus its verified rows so a late
 * response can be fenced against the field's current value by the caller.
 */
export async function aiSearchTasks(query: string, options: AiTaskSearchOptions = {}): Promise<AiTaskSearchResponse<Task>> {
  const path = withProjectId("/ai/search-tasks", options.projectId);

  /*
  A client ceiling below the 30s proxy budget and above the 25s server generation budget, so a wedged
  transport surfaces as a bounded client timeout instead of an indefinitely pending panel. The caller's
  own signal still wins when it aborts first.
  */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TASK_SEARCH_CLIENT_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    return await proxyApi<AiTaskSearchResponse<Task>>(path, {
      method: "POST",
      body: JSON.stringify({ query }),
      signal: controller.signal,
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options.localNodeId ? { localNodeId: options.localNodeId } : {}),
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
