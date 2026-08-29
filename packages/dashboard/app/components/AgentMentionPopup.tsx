import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "./AgentAvatar";
import "./AgentMentionPopup.css";
import type { Agent } from "@fusion/core";
import { matchesAgentMentionFilter } from "./mentionMatching";

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
  /** Room-member ids when mentioning from a room context */
  roomMemberIds?: ReadonlySet<string>;
  /** Optional room name for room section labels */
  roomName?: string;
}

export function AgentMentionPopup({
  agents,
  filter,
  highlightedIndex,
  visible,
  onSelect,
  position = "below",
  roomMemberIds,
  roomName,
}: AgentMentionPopupProps) {
  const { t } = useTranslation("app");
  const filteredAgents = useMemo(() => agents.filter((agent) => matchesAgentMentionFilter(agent.name, filter)), [agents, filter]);

  const roomMode = Boolean(roomMemberIds);
  const showOtherSection = roomMode && filter.trim().length > 0;

  const memberAgents = useMemo(
    () => roomMode ? filteredAgents.filter((agent) => roomMemberIds?.has(agent.id)) : filteredAgents,
    [filteredAgents, roomMemberIds, roomMode],
  );
  const otherAgents = useMemo(
    () => roomMode ? filteredAgents.filter((agent) => !roomMemberIds?.has(agent.id)) : [],
    [filteredAgents, roomMemberIds, roomMode],
  );
  const visibleAgents = showOtherSection ? [...memberAgents, ...otherAgents] : memberAgents;

  if (!visible) {
    return null;
  }

  return (
    <div
      className={`agent-mention-popup agent-mention-popup--${position}`}
      data-testid="agent-mention-popup"
      role="listbox"
      aria-label={t("agentMention.suggestionsLabel", "Agent mention suggestions")}
    >
      {visibleAgents.length === 0 ? (
        <div className="agent-mention-empty">{t("agentMention.noAgentsFound", "No agents found")}</div>
      ) : (
        <>
          {roomMode && (
            <div className="agent-mention-section-header" data-testid="agent-mention-members-header">
              {roomName ? t("agentMention.membersOf", "Members of #{{roomName}}", { roomName }) : t("agentMention.roomMembers", "Room members")}
            </div>
          )}
          {memberAgents.map((agent, index) => (
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
              <AgentAvatar agent={agent} size={20} />
              {roomMode && <span className="status-dot agent-mention-member-dot" aria-label={t("agentMention.roomMemberBadge", "Room member")} />}
              <span className="agent-mention-name">{agent.name}</span>
              <span className="agent-mention-role">{agent.role}</span>
            </button>
          ))}
          {roomMode && !showOtherSection && otherAgents.length > 0 && (
            <div className="agent-mention-hint" data-testid="agent-mention-other-hint">{t("agentMention.typeToSearch", "Type to search other agents")}</div>
          )}
          {roomMode && showOtherSection && otherAgents.length > 0 && (
            <>
              <div className="agent-mention-section-header" data-testid="agent-mention-others-header">{t("agentMention.otherAgents", "Other agents")}</div>
              {otherAgents.map((agent, index) => {
                const globalIndex = memberAgents.length + index;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`agent-mention-item${globalIndex === highlightedIndex ? " agent-mention-item--highlighted" : ""}`}
                    data-testid={`agent-mention-item-${agent.id}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelect(agent)}
                    role="option"
                    aria-selected={globalIndex === highlightedIndex}
                  >
                    <AgentAvatar agent={agent} size={20} />
                    <span className="agent-mention-name">{agent.name}</span>
                    <span className="agent-mention-role">{agent.role}</span>
                  </button>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}
