import { useState, useMemo, useCallback, useEffect } from "react";
import type { Agent } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";

const EXPANDED_KEY = "kb-agent-tree-expanded";

export interface AgentNode {
  agent: Agent;
  children: AgentNode[];
  depth: number;
}

export interface UseAgentHierarchyReturn {
  rootNodes: AgentNode[];
  toggleExpand: (agentId: string) => void;
  isExpanded: (agentId: string) => boolean;
  getChildren: (agentId: string) => Agent[];
  isLoading: boolean;
}

function readExpandedFromStorage(projectId?: string): Set<string> {
  try {
    const stored = getScopedItem(EXPANDED_KEY, projectId);
    if (stored) {
      const parsed: string[] = JSON.parse(stored);
      return new Set(Array.isArray(parsed) ? parsed : []);
    }
  } catch {
    // Gracefully degrade if localStorage is unavailable
  }
  return new Set();
}

function writeExpandedToStorage(expanded: Set<string>, projectId?: string): void {
  try {
    setScopedItem(EXPANDED_KEY, JSON.stringify([...expanded]), projectId);
  } catch {
    // Gracefully degrade if localStorage is unavailable
  }
}

function buildTree(agents: Agent[], expanded: Set<string>): AgentNode[] {
  const agentMap = new Map<string, Agent>();
  const childrenMap = new Map<string, Agent[]>();

  for (const agent of agents) {
    agentMap.set(agent.id, agent);
    if (agent.reportsTo) {
      const siblings = childrenMap.get(agent.reportsTo) ?? [];
      siblings.push(agent);
      childrenMap.set(agent.reportsTo, siblings);
    }
  }

  function buildNode(agent: Agent, depth: number): AgentNode {
    const childAgents = childrenMap.get(agent.id) ?? [];
    const children: AgentNode[] = expanded.has(agent.id)
      ? childAgents.map((child) => buildNode(child, depth + 1))
      : [];

    return { agent, children, depth };
  }

  // Root nodes are agents with no reportsTo or whose reportsTo points to non-existent agent
  return agents
    .filter((agent) => !agent.reportsTo || !agentMap.has(agent.reportsTo))
    .map((agent) => buildNode(agent, 0));
}

/**
 * Hook for managing agent hierarchy (manager-employee relationships).
 * Derives the tree structure from the `reportsTo` field on agents.
 * Expand/collapse state is persisted to localStorage.
 */
export function useAgentHierarchy(agents: Agent[], projectId?: string): UseAgentHierarchyReturn {
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpandedFromStorage(projectId));

  useEffect(() => {
    setExpanded(readExpandedFromStorage(projectId));
  }, [projectId]);

  const rootNodes = useMemo(() => buildTree(agents, expanded), [agents, expanded]);

  const toggleExpand = useCallback((agentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      writeExpandedToStorage(next, projectId);
      return next;
    });
  }, [projectId]);

  const isExpanded = useCallback(
    (agentId: string) => expanded.has(agentId),
    [expanded],
  );

  const getChildren = useCallback(
    (agentId: string): Agent[] => {
      return agents.filter((a) => a.reportsTo === agentId);
    },
    [agents],
  );

  return {
    rootNodes,
    toggleExpand,
    isExpanded,
    getChildren,
    isLoading: false, // tree is derived from pre-fetched agents
  };
}
