import type { DiscoveredSkill } from "../api";

const SKILL_PATH_LABEL_PATTERN = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i;

export type AgentSkillState = "auto-available" | "disabled" | "unknown" | "pending";

export interface AgentSkillClassification {
  state: AgentSkillState;
  forced: boolean;
  labelKey: string;
  defaultLabel: string;
  titleKey: string;
  defaultTitle: string;
}

/**
 * Formats stored skill IDs consistently across agent display surfaces.
 */
export function formatAgentSkillBadgeLabel(skillId: string): string {
  const trimmedSkillId = skillId.trim();
  if (!trimmedSkillId) return skillId;

  const match = trimmedSkillId.match(SKILL_PATH_LABEL_PATTERN);
  return match?.[1] ?? trimmedSkillId;
}

/**
 * Classifies a stored agent skill against the canonical discovery response.
 * A missing response is pending rather than unknown because discovery may still load or retry.
 */
export function classifyAgentSkill(
  skillId: string,
  discovered: DiscoveredSkill[] | null,
  options: { forced: boolean },
): AgentSkillClassification {
  if (discovered === null) {
    return classification("pending", options.forced);
  }

  const skill = discovered.find((candidate) => candidate.id === skillId);
  return classification(skill ? (skill.enabled ? "auto-available" : "disabled") : "unknown", options.forced);
}

function classification(state: AgentSkillState, forced: boolean): AgentSkillClassification {
  const labels: Record<AgentSkillState, Omit<AgentSkillClassification, "state" | "forced">> = {
    "auto-available": {
      labelKey: "skills.autoAvailable",
      defaultLabel: "Auto-available",
      titleKey: "skills.autoAvailableTitle",
      defaultTitle: "Enabled skills are available automatically.",
    },
    disabled: {
      labelKey: "skills.disabledSkill",
      defaultLabel: "Disabled",
      titleKey: "skills.disabledSkillTitle",
      defaultTitle: "Disabled skills are not delivered to sessions, even when forced.",
    },
    unknown: {
      labelKey: "skills.notDiscovered",
      defaultLabel: "Not discovered",
      titleKey: "skills.notDiscoveredTitle",
      defaultTitle: "This stored skill is no longer discovered by the project.",
    },
    pending: {
      labelKey: "skills.skillStatePending",
      defaultLabel: "Checking availability",
      titleKey: "skills.skillStatePendingTitle",
      defaultTitle: "Skill discovery is loading or could not be refreshed.",
    },
  };
  return { state, forced, ...labels[state] };
}
