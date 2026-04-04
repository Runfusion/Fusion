import { useState, useEffect, useCallback } from "react";
import type { Agent, AgentState, AgentCapability, AgentStats } from "../api";
import { fetchAgents, fetchAgentStats } from "../api";

export function useAgents(projectId?: string) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadAgents = useCallback(async (filter?: { state?: AgentState; role?: AgentCapability }) => {
    setIsLoading(true);
    try {
      const data = await fetchAgents(filter, projectId);
      setAgents(data);
    } catch (err) {
      console.error("Failed to load agents:", err);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  const loadStats = useCallback(async () => {
    try {
      const data = await fetchAgentStats(projectId);
      setStats(data);
    } catch (err) {
      console.error("Failed to load agent stats:", err);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAgents();
    void loadStats();
  }, [loadAgents, loadStats]);

  // SSE subscription for agent events
  useEffect(() => {
    if (!projectId) return;
    const query = `?projectId=${encodeURIComponent(projectId)}`;
    const es = new EventSource(`/api/events${query}`);

    const refresh = () => {
      void loadAgents();
      void loadStats();
    };

    es.addEventListener("agent:created", refresh);
    es.addEventListener("agent:updated", refresh);
    es.addEventListener("agent:deleted", refresh);
    es.addEventListener("agent:stateChanged", refresh);

    return () => {
      es.close();
    };
  }, [projectId, loadAgents, loadStats]);

  const activeAgents = agents.filter(a => a.state === "active" || a.state === "running");

  return { agents, activeAgents, stats, isLoading, loadAgents, loadStats };
}
