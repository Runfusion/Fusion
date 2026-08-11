/**
 * FNXC:CodeOrganization 2026-08-03-11:55:
 * getAuthoritativeAssignedAgent peeled from TaskExecutor (U4).
 *
 * FNXC:ModelResolution 2026-07-10-00:00:
 * Task execution sessions must honor the assigned permanent agent's runtimeConfig like chat sessions do. If the live executor was handed an agents-less worktree AgentStore, fall back to the authoritative project `.fusion` AgentStore.
 *
 * FNXC:PostgresOnlyDataAccess 2026-07-17-14:20 / 16:10:
 * Fallback AgentStore MUST inherit TaskStore AsyncDataLayer. Do not memoize a layer-less store.
 */
import { join } from "node:path";
import type { Agent, AgentStore as AgentStoreType, TaskStore } from "@fusion/core";
import { AgentStore } from "@fusion/core";
import { executorLog } from "../logger.js";

export type GetAuthoritativeAssignedAgentDeps = {
  store: TaskStore;
  rootDir: string;
  agentStore?: AgentStoreType | null;
  getAuthoritativeAssignedAgentStore: () => AgentStoreType | null | undefined;
  setAuthoritativeAssignedAgentStore: (store: AgentStoreType) => void;
};

export async function getAuthoritativeAssignedAgent(
  deps: GetAuthoritativeAssignedAgentDeps,
  assignedAgentId: string | null | undefined,
): Promise<Agent | null> {
  const normalizedId = assignedAgentId?.trim();
  if (!normalizedId) return null;

  const configuredAgent = await deps.agentStore?.getAgent(normalizedId).catch(() => null) ?? null;
  if (configuredAgent) return configuredAgent;

  try {
    const authoritativeAgentLayer = deps.store.getAsyncLayer();
    let authoritativeStore = deps.getAuthoritativeAssignedAgentStore();
    if (!authoritativeStore || (authoritativeAgentLayer && !authoritativeStore.backendMode)) {
      authoritativeStore = new AgentStore({
        rootDir: join(deps.rootDir, ".fusion"),
        taskStore: deps.store,
        ...(authoritativeAgentLayer ? { asyncLayer: authoritativeAgentLayer } : {}),
      });
      deps.setAuthoritativeAssignedAgentStore(authoritativeStore);
    }
    await authoritativeStore.init();
    return await authoritativeStore.getAgent(normalizedId).catch(() => null);
  } catch (err: unknown) {
    executorLog.warn(`Failed to read assigned agent ${normalizedId} from authoritative project AgentStore: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
