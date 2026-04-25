import { useMemo } from "react";
import { Bot } from "lucide-react";
import "./AgentMentionPopup.css";
import type { Agent } from "@fusion/core";

interface AgentMentionPopupProps {
  /** List of agents to show */
  agents: Agent[];
  /** Current search filter text (the text typed after @) */
  filter: string;
  /** Currently highlighted index for keyboard navigation */
  highlightedIndex: number;
  /** Whether popup is visible */
  visible: boolean;
  /** Callback when an agent is selected */
  onSelect: (agent: Agent) => void;
  /** Positioning anchor: "above" | "below" the input */
  position?: "above" | "below";
}

export function AgentMentionPopup({
  agents,
  filter,
  highlightedIndex,
  visible,
  onSelect,
  position = "below",
}: AgentMentionPopupProps) {
  const filteredAgents = useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase();
    if (!normalizedFilter) {
      return agents;
    }

    return agents.filter((agent) => agent.name.toLowerCase().includes(normalizedFilter));
  }, [agents, filter]);

  if (!visible) {
    return null;
  }

  return (
    <div
      className={`agent-mention-popup agent-mention-popup--${position}`}
      data-testid="agent-mention-popup"
      role="listbox"
      aria-label="Agent mention suggestions"
    >
      {filteredAgents.length === 0 ? (
        <div className="agent-mention-empty">No agents found</div>
      ) : (
        filteredAgents.map((agent, index) => (
          <button
            key={agent.id}
            type="button"
            className={`agent-mention-item${index === highlightedIndex ? " agent-mention-item--highlighted" : ""}`}
            data-testid={`agent-mention-item-${agent.id}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(agent)}
            role="option"
            aria-selected={index === highlightedIndex}
          >
            <Bot size={14} aria-hidden="true" />
            <span className="agent-mention-name">{agent.name}</span>
            <span className="agent-mention-role">{agent.role}</span>
          </button>
        ))
      )}
    </div>
  );
}
