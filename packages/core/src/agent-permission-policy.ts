import type {
  AgentPermissionPolicy,
  AgentPermissionPolicyDisposition,
  AgentPermissionPolicyPresetId,
  AgentPermissionPolicyRules,
} from "./types.js";
import { AGENT_PERMISSION_POLICY_ACTION_CATEGORIES, AGENT_PERMISSION_POLICY_PRESET_IDS } from "./types.js";

export const DEFAULT_AGENT_PERMISSION_POLICY_PRESET_ID: AgentPermissionPolicyPresetId = "unrestricted";

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
