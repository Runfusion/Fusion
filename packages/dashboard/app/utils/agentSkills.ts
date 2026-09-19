import type { DiscoveredSkill } from "../api";

const SKILL_PATH_LABEL_PATTERN = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i;

export type AgentSkillState = "auto-available" | "disabled" | "unknown" | "pending";

export interface AgentSkillClassification {
  state: AgentSkillState;
  forced: boolean;
  /** Canonical discovered identity for compatible stored references, when available. */
  resolvedSkillId?: string;
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
 * Reduce stored and discovered names to the execution resolver's compatible bare token.
 */
export function requestedSkillMatchKey(skillReference: string): string {
  if (!skillReference) return "";
  const withoutSkillMd = skillReference.replace(/\/SKILL\.md$/i, "");
  const lastPathSegment = withoutSkillMd.split("/").pop() ?? withoutSkillMd;
  const afterNamespace = lastPathSegment.split(":").pop() ?? lastPathSegment;
  return afterNamespace.toLowerCase();
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

  const exactMatch = discovered.find((candidate) => candidate.id === skillId);
  if (exactMatch) {
    return classification(exactMatch.enabled ? "auto-available" : "disabled", options.forced, exactMatch.id);
  }

  /*
   * FNXC:AgentSkillDiscovery 2026-09-19-20:23:
   * Agent metadata can retain bare, path-shaped, or source-qualified references from older
   * discovery formats. Mirror execution matching only after exact IDs so a disabled canonical
   * entry remains authoritative while an enabled equivalent can restore legacy availability.
   */
  const matchKey = requestedSkillMatchKey(skillId);
  const compatibleMatches = matchKey
    ? discovered.filter((candidate) => requestedSkillMatchKey(candidate.name) === matchKey)
    : [];
  const resolvedMatch = compatibleMatches.find((candidate) => candidate.enabled) ?? compatibleMatches[0];

  return resolvedMatch
    ? classification(resolvedMatch.enabled ? "auto-available" : "disabled", options.forced, resolvedMatch.id)
    : classification("unknown", options.forced);
}

function classification(state: AgentSkillState, forced: boolean, resolvedSkillId?: string): AgentSkillClassification {
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
  return { state, forced, ...(resolvedSkillId ? { resolvedSkillId } : {}), ...labels[state] };
}
