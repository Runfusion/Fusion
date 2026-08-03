/**
 * FNXC:CodeOrganization 2026-08-03-14:15:
 * resolveMcpServers peeled from TaskExecutor (U4).
 *
 * FNXC:McpConfig 2026-06-25-22:20:
 * Executor-owned lanes resolve trusted MCP servers from the task store immediately before session creation.
 *
 * FNXC:McpConfig 2026-07-12-17:02:
 * Secret-resolution failures remain content-free and observable; healthy servers continue.
 */
import type { TaskStore } from "@fusion/core";
import { resolveMcpServersForStore } from "../mcp/mcp-resolution.js";
import { executorLog } from "../logger.js";

export type ResolveMcpServersDeps = {
  store: TaskStore;
};

export async function resolveMcpServers(
  deps: ResolveMcpServersDeps,
  agentId?: string | null,
) {
  /*
   * FNXC:McpConfig 2026-06-25-22:20:
   * Executor-owned lanes (main execution, retry, workflow model nodes, self-fix, and spawned child sessions) resolve the same trusted MCP server set from the task store immediately before session creation so secret material is never persisted in task state.
   *
   * FNXC:McpConfig 2026-07-12-17:02:
   * Secret-resolution failures remain content-free and observable. The
   * resolver excludes each affected server so it cannot connect with missing
   * credentials, while healthy MCP servers and task execution continue.
   */
  const resolved = await resolveMcpServersForStore(deps.store, { agentId: agentId ?? undefined });
  if (resolved.errors.length > 0) {
    const serverNames = [...new Set(resolved.errors.map((error) => error.serverName))].sort();
    executorLog.warn(`MCP executor resolution failed: servers=${serverNames.join(",")} count=${serverNames.length} reason=secret-materialization`);
  }
  return resolved.servers;
}
