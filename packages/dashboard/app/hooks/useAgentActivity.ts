import { useEffect, useRef, useSyncExternalStore } from "react";
import { agentActivityStore } from "./agentActivityStore";

let nextHookId = 0;

/** Thin retained view of the shared agent-activity stream. */
export function useAgentActivity(projectId?: string) {
  const hookId = useRef<string | null>(null);
  if (!hookId.current) hookId.current = `agent-activity-${++nextHookId}`;

  useEffect(() => {
    const id = hookId.current!;
    agentActivityStore.retain(id, projectId);
    return () => agentActivityStore.release(id);
  }, [projectId]);

  return useSyncExternalStore(agentActivityStore.subscribe, agentActivityStore.getSnapshot, agentActivityStore.getSnapshot);
}
