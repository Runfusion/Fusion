import type {
  AgentPermissionPolicy,
  AgentPermissionPolicyDisposition,
  AgentPermissionPolicyPresetId,
  AgentPermissionPolicyRules,
  AgentPermissionPolicyToolRules,
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
    rules: withReviewGateBypassOverride(buildRules("allow")),
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
    rules: withReviewGateBypassOverride(buildRules("allow")),
  },
};

function buildRules(disposition: AgentPermissionPolicyDisposition): AgentPermissionPolicyRules {
  return AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.reduce((acc, category) => {
    acc[category] = disposition;
    return acc;
  }, {} as AgentPermissionPolicyRules);
}

/**
 * FNXC:ToolPermissions 2026-07-09-00:00:
 * FN-7728 — `review_gate_bypass` (governing the `fn_task_bypass_review` merge-gate override) intentionally diverges from the uniform per-preset disposition: even the `unrestricted` preset (and the `unrestricted`-seeded `custom` base) must never silently allow a review-gate bypass by default, since that is a stricter security posture than ordinary task mutation. `approval-required` (already `require-approval`) and `locked-down` (already `block`, stricter still) need no override — only the two presets whose uniform disposition would otherwise be `allow` are patched here, post-`buildRules`, so the single-disposition preset builder stays simple for every other category.
 */
function withReviewGateBypassOverride(rules: AgentPermissionPolicyRules): AgentPermissionPolicyRules {
  return { ...rules, review_gate_bypass: "require-approval" };
}

export function isValidAgentPermissionPolicyDisposition(value: unknown): value is AgentPermissionPolicyDisposition {
  return typeof value === "string" && (VALID_DISPOSITIONS as readonly string[]).includes(value);
}

function normalizeToolRules(
  toolRules: Partial<AgentPermissionPolicyToolRules> | undefined,
  errorPrefix: string,
): AgentPermissionPolicyToolRules | undefined {
  if (toolRules === undefined) return undefined;
  if (!toolRules || typeof toolRules !== "object" || Array.isArray(toolRules)) {
    throw new Error(`${errorPrefix} toolRules must be an object`);
  }

  const normalized: AgentPermissionPolicyToolRules = {};
  for (const [rawToolName, disposition] of Object.entries(toolRules)) {
    const toolName = rawToolName.trim();
    if (!toolName) {
      throw new Error(`${errorPrefix} toolRules contains a blank tool name`);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, toolName)) {
      throw new Error(`${errorPrefix} toolRules contains duplicate tool name ${toolName}`);
    }
    if (!isValidAgentPermissionPolicyDisposition(disposition)) {
      throw new Error(`${errorPrefix} toolRules.${toolName} has invalid disposition: ${String(disposition)}`);
    }
    normalized[toolName] = disposition;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
  toolRules?: Partial<AgentPermissionPolicyToolRules>;
}): AgentPermissionPolicy {
  const preset = resolveAgentPermissionPolicyPreset(input.presetId);
  const toolRules = normalizeToolRules(input.toolRules, "permission policy");
  if (input.presetId !== "custom") {
    return {
      presetId: input.presetId,
      rules: { ...preset.rules },
      ...(toolRules ? { toolRules } : {}),
    };
  }

  const rules: AgentPermissionPolicyRules = { ...resolveAgentPermissionPolicyPreset("unrestricted").rules };
  for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
    const nextValue = input.rules?.[category];
    if (nextValue === undefined) {
      continue;
    }
    if (!isValidAgentPermissionPolicyDisposition(nextValue)) {
      throw new Error(`Invalid permission policy disposition for ${category}: ${String(nextValue)}`);
    }
    rules[category] = nextValue;
  }

  return {
    presetId: "custom",
    rules,
    ...(toolRules ? { toolRules } : {}),
  };
}

function normalizeProjectDefaultPolicy(
  projectDefault: { rules?: Partial<AgentPermissionPolicyRules>; toolRules?: Partial<AgentPermissionPolicyToolRules> } | undefined,
): AgentPermissionPolicy {
  const seed = resolveAgentPermissionPolicyPreset(DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID).rules;
  const merged: Partial<AgentPermissionPolicyRules> = {};
  const toolRules = normalizeToolRules(projectDefault?.toolRules, "project default permission policy");

  for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
    const nextValue = projectDefault?.rules?.[category];
    if (nextValue === undefined) {
      continue;
    }
    if (!isValidAgentPermissionPolicyDisposition(nextValue)) {
      throw new Error(`Invalid project default permission policy disposition for ${category}: ${String(nextValue)}`);
    }
    merged[category] = nextValue;
  }

  if (Object.keys(merged).length === 0 && !toolRules) {
    return normalizeAgentPermissionPolicyFromPreset(DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID);
  }

  return normalizeAgentPermissionPolicy({
    presetId: "custom",
    rules: { ...seed, ...merged },
    ...(toolRules ? { toolRules } : {}),
  });
}

export function resolveEffectiveAgentPermissionPolicy(
  policy: { presetId: string; rules?: Partial<AgentPermissionPolicyRules>; toolRules?: Partial<AgentPermissionPolicyToolRules> } | undefined,
  projectDefault?: { rules?: Partial<AgentPermissionPolicyRules>; toolRules?: Partial<AgentPermissionPolicyToolRules> },
): AgentPermissionPolicy {
  if (!policy || !isAgentPermissionPolicyPresetId(policy.presetId)) {
    return normalizeProjectDefaultPolicy(projectDefault);
  }

  /*
  FNXC:ToolPermissions 2026-07-01-00:00:
  Runtime permission resolution is intentionally ordered as per-agent exact tool override, then per-agent category rule, then project-default exact tool override, then project-default category rule, then the unrestricted built-in default. A configured per-agent policy is normalized as a full override; agents with no policy inherit the normalized project default.
  */
  return normalizeAgentPermissionPolicy({
    presetId: policy.presetId,
    rules: policy.rules,
    toolRules: policy.toolRules,
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

const EXACT_TOOL_CATEGORY_HINTS = new Map<string, (typeof AGENT_PERMISSION_POLICY_ACTION_CATEGORIES)[number]>(
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.flatMap((category) =>
    AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES[category]
      .filter((toolName) => /^[A-Za-z0-9_-]+$/.test(toolName))
      .map((toolName) => [toolName, category] as const),
  ),
);

function toolDispositionRank(policy: AgentPermissionPolicy, toolName: string): number {
  const exactDisposition = policy.toolRules?.[toolName];
  if (exactDisposition !== undefined) return DISPOSITION_BREADTH_RANK[exactDisposition];

  const category = EXACT_TOOL_CATEGORY_HINTS.get(toolName);
  if (category) return dispositionRank(policy.rules, category);

  return BROADEST_RANK;
}

/**
 * True when `agentPolicy`'s effective policy is broader (more privileged) than
 * the project `defaultPolicy` on at least one action category or exact tool (R13).
 *
 * Both arguments should already be resolved via
 * {@link resolveEffectiveAgentPermissionPolicy}, which fills every category. The
 * defensive per-category handling here guards against a partial/custom rules
 * map slipping through with a missing category key — an absent key must never
 * silently suppress a genuine escalation. Exact tool keys compare against their
 * known category fallback when possible, so an agent category `allow` still
 * escalates over a project default `toolRules.fn_task_create = "block"`.
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

  const toolNames = new Set([
    ...Object.keys(agentPolicy.toolRules ?? {}),
    ...Object.keys(defaultPolicy.toolRules ?? {}),
  ]);
  for (const toolName of toolNames) {
    const agentRank = toolDispositionRank(agentPolicy, toolName);
    const defaultRank = toolDispositionRank(defaultPolicy, toolName);
    if (agentRank < defaultRank) return true;
  }
  return false;
}
