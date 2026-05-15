import "./AgentPermissionPolicyEditor.css";
import {
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  type AgentPermissionPolicy,
  type AgentPermissionPolicyDisposition,
  type AgentPermissionPolicyRules,
} from "@fusion/core";

type Mode = "project-default" | "agent-override";

interface Props {
  value: AgentPermissionPolicy | undefined;
  projectDefault?: Partial<AgentPermissionPolicyRules>;
  mode: Mode;
  onChange(next: AgentPermissionPolicy | undefined): void;
  disabled?: boolean;
}

const DISPOSITIONS: AgentPermissionPolicyDisposition[] = ["allow", "require-approval", "block"];

const CATEGORY_LABELS: Record<string, { label: string; description: string }> = {
  git_write: { label: "Git writes", description: "Commits, branch updates, and merge-affecting git changes." },
  file_write_delete: { label: "File writes/deletes", description: "Create, edit, or remove files in the workspace." },
  command_execution: { label: "Command execution", description: "Runs shell commands and scripts." },
  network_api: { label: "Network/API", description: "Outbound network or API access." },
  task_agent_mutation: { label: "Task/agent mutation", description: "Task state changes, delegation, or agent lifecycle actions." },
};

function buildAllowRules(): AgentPermissionPolicyRules {
  return {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
  };
}

const PRESET_RULES: Record<"unrestricted" | "approval-required" | "locked-down", AgentPermissionPolicyRules> = {
  unrestricted: {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
  },
  "approval-required": {
    git_write: "require-approval",
    file_write_delete: "require-approval",
    command_execution: "require-approval",
    network_api: "require-approval",
    task_agent_mutation: "require-approval",
  },
  "locked-down": {
    git_write: "block",
    file_write_delete: "block",
    command_execution: "block",
    network_api: "block",
    task_agent_mutation: "block",
  },
};

function getPresetRules(presetId: "unrestricted" | "approval-required" | "locked-down"): AgentPermissionPolicyRules {
  return PRESET_RULES[presetId];
}

function matchesRules(a: AgentPermissionPolicyRules, b: AgentPermissionPolicyRules): boolean {
  return AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.every((category) => a[category] === b[category]);
}

function derivePresetFromRules(rules: AgentPermissionPolicyRules): AgentPermissionPolicy["presetId"] {
  if (matchesRules(rules, PRESET_RULES.unrestricted)) return "unrestricted";
  if (matchesRules(rules, PRESET_RULES["approval-required"])) return "approval-required";
  if (matchesRules(rules, PRESET_RULES["locked-down"])) return "locked-down";
  return "custom";
}

export function AgentPermissionPolicyEditor({ value, projectDefault, mode, onChange, disabled = false }: Props) {
  const derivedPreset = value ? derivePresetFromRules(value.rules) : "unrestricted";
  const currentPreset = mode === "agent-override" && !value ? "inherit" : (value?.presetId === "custom" ? derivedPreset : (value?.presetId ?? "unrestricted"));
  const rules = value?.rules ?? buildAllowRules();

  const setPreset = (preset: string) => {
    if (mode === "agent-override" && preset === "inherit") {
      onChange(undefined);
      return;
    }
    if (preset === "custom") {
      onChange({ presetId: "custom", rules: { ...rules } });
      return;
    }
    onChange({ presetId: preset as AgentPermissionPolicy["presetId"], rules: getPresetRules(preset as "unrestricted" | "approval-required" | "locked-down") });
  };

  const setRule = (category: keyof AgentPermissionPolicyRules, next: string) => {
    if (mode === "agent-override" && next === "inherit") {
      if (!value) return;
      const nextRules = { ...value.rules };
      nextRules[category] = projectDefault?.[category] ?? "allow";
      onChange({ presetId: "custom", rules: nextRules });
      return;
    }
    const nextRules = { ...rules, [category]: next as AgentPermissionPolicyDisposition };
    onChange({ presetId: "custom", rules: nextRules });
  };

  return (
    <div className="agent-policy-editor card">
      <div className="form-group">
        <label htmlFor="agent-policy-preset">Preset</label>
        <select
          id="agent-policy-preset"
          className="select"
          value={currentPreset}
          onChange={(event) => setPreset(event.target.value)}
          disabled={disabled}
        >
          {mode === "agent-override" ? <option value="inherit">Inherit project default</option> : null}
          <option value="unrestricted">Unrestricted</option>
          <option value="approval-required">Approval Required</option>
          <option value="locked-down">Locked Down</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      <div className="agent-policy-table" role="table" aria-label="Permission policy categories">
        {AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.map((category) => {
          const meta = CATEGORY_LABELS[category] ?? { label: category, description: "" };
          const inherited = projectDefault?.[category] ?? "allow";
          const effective = rules[category] ?? "allow";
          const rowValue = mode === "agent-override" && !value ? "inherit" : effective;
          return (
            <div key={category} className="agent-policy-row" role="row">
              <div className="agent-policy-cell">
                <strong>{meta.label}</strong>
                <div className="agent-policy-description">{meta.description}</div>
                <ul className="agent-policy-examples" aria-label={`${meta.label} examples`}>
                  {(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES[category] ?? []).map((toolName) => (
                    <li key={`${category}-${toolName}`}>
                      <code>{toolName}</code>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="agent-policy-cell">
                <select
                  className="select"
                  value={rowValue}
                  onChange={(event) => setRule(category, event.target.value)}
                  disabled={disabled}
                >
                  {mode === "agent-override" ? <option value="inherit">Inherit</option> : null}
                  {DISPOSITIONS.map((disposition) => (
                    <option key={disposition} value={disposition}>
                      {disposition === "require-approval" ? "Require approval" : disposition[0]?.toUpperCase() + disposition.slice(1)}
                    </option>
                  ))}
                </select>
                {mode === "agent-override" && rowValue === "inherit" ? (
                  <div className="agent-policy-inherit-note">from project default: {inherited === "require-approval" ? "Require approval" : inherited}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <details className="agent-policy-exempt" open={false}>
        <summary>Tools exempt from approval policy</summary>
        <p>
          These coordination tools bypass approval policy so heartbeats and inter-agent messaging cannot deadlock. They
          are not user-configurable.
        </p>
        <ul className="agent-policy-exempt-list">
          {AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES.map((toolName) => (
            <li key={toolName}>
              <code>{toolName}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
