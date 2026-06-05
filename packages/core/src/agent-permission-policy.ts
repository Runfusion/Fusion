import type {
  AgentPermissionPolicy,
  AgentPermissionPolicyDisposition,
  AgentPermissionPolicyPresetId,
  AgentPermissionPolicyRules,
} from "./types.js";
import {
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_PRESET_IDS,
} from "./types.js";

export const DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID: AgentPermissionPolicyPresetId = "unrestricted";

export { AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES, AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES };

export interface BuiltInAgentPermissionPolicyPreset {
  id: AgentPermissionPolicyPresetId;
  name: string;
  description: string;
  rules: AgentPermissionPolicyRules;
}

const VALID_DISPOSITIONS: readonly AgentPermissionPolicyDisposition[] = ["allow", "block", "require-approval"] as const;

const BUILT_IN_PRESETS: Record<AgentPermissionPolicyPresetId, BuiltInAgentPermissionPolicyPreset> = {
  unrestricted: {
    id: "unrestricted",
    name: "Unrestricted",
    description: "Allows all runtime action categories (legacy-compatible default).",
    rules: buildRules("allow"),
  },
  "approval-required": {
    id: "approval-required",
    name: "Approval Required",
    description: "Requires approval for all runtime action categories.",
    rules: buildRules("require-approval"),
  },
  "locked-down": {
    id: "locked-down",
    name: "Locked Down",
    description: "Blocks all runtime action categories.",
    rules: buildRules("block"),
  },
  custom: {
    id: "custom",
    name: "Custom",
    description: "Category-level custom overrides.",
    rules: buildRules("allow"),
  },
};

function buildRules(disposition: AgentPermissionPolicyDisposition): AgentPermissionPolicyRules {
  return AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.reduce((acc, category) => {
    acc[category] = disposition;
    return acc;
  }, {} as AgentPermissionPolicyRules);
}

function isValidDisposition(value: unknown): value is AgentPermissionPolicyDisposition {
  return typeof value === "string" && (VALID_DISPOSITIONS as readonly string[]).includes(value);
}

export function isAgentPermissionPolicyPresetId(value: unknown): value is AgentPermissionPolicyPresetId {
  return typeof value === "string" && (AGENT_PERMISSION_POLICY_PRESET_IDS as readonly string[]).includes(value);
}

export function getBuiltInAgentPermissionPolicyPresets(): BuiltInAgentPermissionPolicyPreset[] {
  return AGENT_PERMISSION_POLICY_PRESET_IDS.map((id) => resolveAgentPermissionPolicyPreset(id));
}

export function resolveAgentPermissionPolicyPreset(
  presetId: AgentPermissionPolicyPresetId,
): BuiltInAgentPermissionPolicyPreset {
  const preset = BUILT_IN_PRESETS[presetId];
  return {
    ...preset,
    rules: { ...preset.rules },
  };
}

export function normalizeAgentPermissionPolicyFromPreset(
  presetId: AgentPermissionPolicyPresetId,
): AgentPermissionPolicy {
  return normalizeAgentPermissionPolicy({ presetId });
}

export function normalizeAgentPermissionPolicy(input: {
  presetId: AgentPermissionPolicyPresetId;
  rules?: Partial<AgentPermissionPolicyRules>;
}): AgentPermissionPolicy {
  const preset = resolveAgentPermissionPolicyPreset(input.presetId);
  if (input.presetId !== "custom") {
    return {
      presetId: input.presetId,
      rules: { ...preset.rules },
    };
  }

  const rules: AgentPermissionPolicyRules = { ...resolveAgentPermissionPolicyPreset("unrestricted").rules };
  for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
    const nextValue = input.rules?.[category];
    if (nextValue === undefined) {
      continue;
    }
    if (!isValidDisposition(nextValue)) {
      throw new Error(`Invalid permission policy disposition for ${category}: ${String(nextValue)}`);
    }
    rules[category] = nextValue;
  }

  return {
    presetId: "custom",
    rules,
  };
}

function normalizeProjectDefaultPolicy(
  projectDefault: { rules?: Partial<AgentPermissionPolicyRules> } | undefined,
): AgentPermissionPolicy {
  const seed = resolveAgentPermissionPolicyPreset(DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID).rules;
  const merged: Partial<AgentPermissionPolicyRules> = {};

  for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
    const nextValue = projectDefault?.rules?.[category];
    if (nextValue === undefined) {
      continue;
    }
    if (!isValidDisposition(nextValue)) {
      throw new Error(`Invalid project default permission policy disposition for ${category}: ${String(nextValue)}`);
    }
    merged[category] = nextValue;
  }

  if (Object.keys(merged).length === 0) {
    return normalizeAgentPermissionPolicyFromPreset(DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID);
  }

  return normalizeAgentPermissionPolicy({
    presetId: "custom",
    rules: { ...seed, ...merged },
  });
}

export function resolveEffectiveAgentPermissionPolicy(
  policy: AgentPermissionPolicy | undefined,
  projectDefault?: { rules?: Partial<AgentPermissionPolicyRules> },
): AgentPermissionPolicy {
  if (!policy || !isAgentPermissionPolicyPresetId(policy.presetId)) {
    return normalizeProjectDefaultPolicy(projectDefault);
  }

  return normalizeAgentPermissionPolicy({
    presetId: policy.presetId,
    rules: policy.rules,
  });
}

/**
 * Disposition strictness rank for column-agent policy-escalation comparison
 * (R13). A LOWER rank is *broader* (more privileged): `allow` lets an action
 * through unconditionally, `require-approval` gates it, `block` denies it. An
 * agent whose policy is broader than the project default on ANY action category
 * is an escalation that must be explicitly confirmed at save time.
 */
const DISPOSITION_BREADTH_RANK: Record<AgentPermissionPolicyDisposition, number> = {
  allow: 0,
  "require-approval": 1,
  block: 2,
};

/**
 * The broadest (most-privileged) rank — used as the fallback when a category is
 * absent from a policy's rules map. Treating a missing category as the broadest
 * possible disposition (`allow`) ensures an absent key can never silently
 * *suppress* a genuine escalation: the comparison only flags when the agent is
 * at least as broad as the default, so an unknown agent-side category errs
 * toward flagging, and an unknown default-side category errs toward the most
 * permissive default (the conservative direction for escalation detection).
 */
const BROADEST_RANK = DISPOSITION_BREADTH_RANK.allow;

function dispositionRank(
  rules: AgentPermissionPolicyRules,
  category: (typeof AGENT_PERMISSION_POLICY_ACTION_CATEGORIES)[number],
): number {
  const disposition = rules[category];
  if (disposition === undefined) {
    // An absent category must not suppress escalation. Treat the agent side as
    // broadest (most privileged) so a missing key never narrows the comparison.
    return BROADEST_RANK;
  }
  return DISPOSITION_BREADTH_RANK[disposition];
}

/**
 * True when `agentPolicy`'s effective policy is broader (more privileged) than
 * the project `defaultPolicy` on at least one action category (R13).
 *
 * Both arguments should already be resolved via
 * {@link resolveEffectiveAgentPermissionPolicy}, which fills every category. The
 * defensive per-category handling here guards against a partial/custom rules
 * map slipping through with a missing category key — an absent key must never
 * silently suppress a genuine escalation.
 */
export function isPolicyBroaderThanDefault(
  agentPolicy: AgentPermissionPolicy,
  defaultPolicy: AgentPermissionPolicy,
): boolean {
  for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
    const agentRank = dispositionRank(agentPolicy.rules, category);
    const defaultRank = dispositionRank(defaultPolicy.rules, category);
    if (agentRank < defaultRank) return true;
  }
  return false;
}
