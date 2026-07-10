import "./AgentPermissionPolicyEditor.css";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES,
  AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES,
  type AgentPermissionPolicy,
  type AgentPermissionPolicyDisposition,
  type AgentPermissionPolicyRules,
  type AgentPermissionPolicyToolRules,
} from "@fusion/core";

type Mode = "project-default" | "agent-override";

interface Props {
  value: AgentPermissionPolicy | undefined;
  projectDefault?: Partial<AgentPermissionPolicyRules>;
  projectDefaultToolRules?: AgentPermissionPolicyToolRules;
  mode: Mode;
  onChange(next: AgentPermissionPolicy | undefined): void;
  disabled?: boolean;
}

const DISPOSITIONS: AgentPermissionPolicyDisposition[] = ["allow", "require-approval", "block"];
const EXACT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function getKnownToolRuleOptions(): string[] {
  const exempt = new Set(AGENT_PERMISSION_POLICY_EXEMPT_TOOL_EXAMPLES);
  const names = new Set<string>();
  for (const examples of Object.values(AGENT_PERMISSION_POLICY_CATEGORY_TOOL_EXAMPLES)) {
    for (const example of examples) {
      if (EXACT_TOOL_NAME_PATTERN.test(example) && !exempt.has(example)) {
        names.add(example);
      }
    }
  }
  return [...names].sort();
}

function getCategoryLabels(t: TFunction<"app">): Record<string, { label: string; description: string }> {
  return {
    git_write: { label: t("agentPolicy.category.gitWrite.label", "Git writes"), description: t("agentPolicy.category.gitWrite.description", "Commits, branch updates, and merge-affecting git changes.") },
    file_write_delete: { label: t("agentPolicy.category.fileWriteDelete.label", "File writes/deletes"), description: t("agentPolicy.category.fileWriteDelete.description", "Create, edit, or remove files in the workspace.") },
    command_execution: { label: t("agentPolicy.category.commandExecution.label", "Command execution"), description: t("agentPolicy.category.commandExecution.description", "Runs shell commands and scripts.") },
    network_api: { label: t("agentPolicy.category.networkApi.label", "Network/API"), description: t("agentPolicy.category.networkApi.description", "Outbound network or API access.") },
    task_agent_mutation: { label: t("agentPolicy.category.taskAgentMutation.label", "Task/agent mutation"), description: t("agentPolicy.category.taskAgentMutation.description", "Task state changes, delegation, or agent lifecycle actions.") },
    // FNXC:ToolPermissions 2026-07-09-00:00: FN-7728 — review_gate_bypass is a dedicated, more-restricted category for the merge-gate override tool, distinct from ordinary task_agent_mutation.
    review_gate_bypass: { label: t("agentPolicy.category.reviewGateBypass.label", "Review gate bypass"), description: t("agentPolicy.category.reviewGateBypass.description", "Bypassing a failed pre-merge review step to force a card past the review lane.") },
    // FNXC:ToolPermissions 2026-07-09-08:30: FN-7737 — file_scope governs the File Scope additional-approval action, distinct from ordinary file_write_delete/task_agent_mutation. Uniform grant-all default (allow), unlike review_gate_bypass.
    file_scope: { label: t("agentPolicy.category.fileScope.label", "File Scope expansion"), description: t("agentPolicy.category.fileScope.description", "Extending a task's declared File Scope beyond its initial spec at runtime.") },
  };
}

function getDispositionLabel(t: TFunction<"app">, disposition: AgentPermissionPolicyDisposition): string {
  if (disposition === "require-approval") return t("agentPolicy.requireApproval", "Require approval");
  if (disposition === "allow") return t("agentPolicy.allow", "Allow");
  if (disposition === "block") return t("agentPolicy.block", "Block");
  // Forward-compat fallback if the disposition union ever grows.
  const raw: string = disposition;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function buildAllowRules(): AgentPermissionPolicyRules {
  return {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
    // FNXC:ToolPermissions 2026-07-09-00:00: FN-7728 — review_gate_bypass mirrors the core unrestricted preset's targeted override (require-approval, not allow) so the editor's derived preset detection stays in sync with agent-permission-policy.ts.
    review_gate_bypass: "require-approval",
    // FNXC:ToolPermissions 2026-07-09-08:30: FN-7737 — file_scope stays uniform allow (no override), mirroring the core unrestricted preset.
    file_scope: "allow",
  };
}

const PRESET_RULES: Record<"unrestricted" | "approval-required" | "locked-down", AgentPermissionPolicyRules> = {
  unrestricted: {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
    // FNXC:ToolPermissions 2026-07-09-00:00: FN-7728 — review_gate_bypass stays require-approval even under the unrestricted preset (see agent-permission-policy.ts withReviewGateBypassOverride).
    review_gate_bypass: "require-approval",
    // FNXC:ToolPermissions 2026-07-09-08:30: FN-7737 — file_scope stays uniform allow under unrestricted (see agent-permission-policy.ts buildRules, no override function applied).
    file_scope: "allow",
  },
  "approval-required": {
    git_write: "require-approval",
    file_write_delete: "require-approval",
    command_execution: "require-approval",
    network_api: "require-approval",
    task_agent_mutation: "require-approval",
    review_gate_bypass: "require-approval",
    file_scope: "require-approval",
  },
  "locked-down": {
    git_write: "block",
    file_write_delete: "block",
    command_execution: "block",
    network_api: "block",
    task_agent_mutation: "block",
    review_gate_bypass: "block",
    file_scope: "block",
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

export function AgentPermissionPolicyEditor({ value, projectDefault, projectDefaultToolRules, mode, onChange, disabled = false }: Props) {
  const { t } = useTranslation("app");
  const categoryLabels = getCategoryLabels(t as TFunction<"app">);
  const knownToolOptions = useMemo(() => getKnownToolRuleOptions(), []);
  const [pendingToolName, setPendingToolName] = useState("fn_task_create");
  const [pendingDisposition, setPendingDisposition] = useState<AgentPermissionPolicyDisposition>("block");
  const derivedPreset = value ? derivePresetFromRules(value.rules) : "unrestricted";
  const currentPreset = mode === "agent-override" && !value ? "inherit" : (value?.presetId === "custom" ? derivedPreset : (value?.presetId ?? "unrestricted"));
  const rules = value?.rules ?? buildAllowRules();
  const toolRules = value?.toolRules ?? {};
  const toolRuleEntries = Object.entries(toolRules).sort(([a], [b]) => a.localeCompare(b));

  const withToolRules = (policy: Omit<AgentPermissionPolicy, "toolRules">): AgentPermissionPolicy => ({
    ...policy,
    ...(Object.keys(toolRules).length > 0 ? { toolRules: { ...toolRules } } : {}),
  });

  const setPreset = (preset: string) => {
    if (mode === "agent-override" && preset === "inherit") {
      onChange(undefined);
      return;
    }
    if (preset === "custom") {
      onChange(withToolRules({ presetId: "custom", rules: { ...rules } }));
      return;
    }
    onChange(withToolRules({ presetId: preset as AgentPermissionPolicy["presetId"], rules: getPresetRules(preset as "unrestricted" | "approval-required" | "locked-down") }));
  };

  const setRule = (category: keyof AgentPermissionPolicyRules, next: string) => {
    if (mode === "agent-override" && next === "inherit") {
      if (!value) return;
      const nextRules = { ...value.rules };
      nextRules[category] = projectDefault?.[category] ?? "allow";
      onChange(withToolRules({ presetId: "custom", rules: nextRules }));
      return;
    }
    const nextRules = { ...rules, [category]: next as AgentPermissionPolicyDisposition };
    onChange(withToolRules({ presetId: "custom", rules: nextRules }));
  };

  const setToolRule = (rawToolName: string, disposition: AgentPermissionPolicyDisposition) => {
    const toolName = rawToolName.trim();
    if (!toolName || !EXACT_TOOL_NAME_PATTERN.test(toolName)) return;
    const nextToolRules = { ...toolRules, [toolName]: disposition };
    onChange({ presetId: "custom", rules: { ...rules }, toolRules: nextToolRules });
  };

  const removeToolRule = (toolName: string) => {
    const nextToolRules = { ...toolRules };
    delete nextToolRules[toolName];
    onChange({
      presetId: "custom",
      rules: { ...rules },
      ...(Object.keys(nextToolRules).length > 0 ? { toolRules: nextToolRules } : {}),
    });
  };

  const addPendingToolRule = () => {
    setToolRule(pendingToolName, pendingDisposition);
  };

  return (
    <div className="agent-policy-editor card">
      <div className="form-group">
        <label htmlFor="agent-policy-preset">{t("agentPolicy.preset", "Preset")}</label>
        <select
          id="agent-policy-preset"
          className="select"
          value={currentPreset}
          onChange={(event) => setPreset(event.target.value)}
          disabled={disabled}
        >
          {mode === "agent-override" ? <option value="inherit">{t("agentPolicy.inheritDefault", "Inherit project default")}</option> : null}
          <option value="unrestricted">{t("agentPolicy.unrestricted", "Unrestricted")}</option>
          <option value="approval-required">{t("agentPolicy.approvalRequired", "Approval Required")}</option>
          <option value="locked-down">{t("agentPolicy.lockedDown", "Locked Down")}</option>
          <option value="custom">{t("agentPolicy.custom", "Custom")}</option>
        </select>
      </div>

      <div className="agent-policy-table" role="table" aria-label={t("agentPolicy.ariaLabel", "Permission policy categories")}>
        {AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.map((category) => {
          const meta = categoryLabels[category] ?? { label: category, description: "" };
          const inherited = projectDefault?.[category] ?? "allow";
          const effective = rules[category] ?? "allow";
          const rowValue = mode === "agent-override" && !value ? "inherit" : effective;
          return (
            <div key={category} className="agent-policy-row" role="row" data-category={category}>
              <div className="agent-policy-cell">
                <strong>{meta.label}</strong>
                <div className="agent-policy-description">{meta.description}</div>
                <ul className="agent-policy-examples" aria-label={t("agentPolicy.categoryExamples", "{{label}} examples", { label: meta.label })}>
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
                  {mode === "agent-override" ? <option value="inherit">{t("agentPolicy.inherit", "Inherit")}</option> : null}
                  {DISPOSITIONS.map((disposition) => (
                    <option key={disposition} value={disposition}>
                      {getDispositionLabel(t as TFunction<"app">, disposition)}
                    </option>
                  ))}
                </select>
                {mode === "agent-override" && rowValue === "inherit" ? (
                  <div className="agent-policy-inherit-note">{t("agentPolicy.fromProjectDefault", "from project default")}: {getDispositionLabel(t as TFunction<"app">, inherited)}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <section className="agent-policy-tool-rules" aria-labelledby="agent-policy-tool-rules-heading">
        <div className="agent-policy-tool-rules-header">
          <div>
            <h4 id="agent-policy-tool-rules-heading">{t("agentPolicy.exactToolOverrides", "Exact tool overrides")}</h4>
            <p>{t("agentPolicy.exactToolOverridesDescription", "Override one governed tool by exact name before its category rule. Heartbeat-critical exempt tools stay non-configurable.")}</p>
          </div>
        </div>

        {toolRuleEntries.length === 0 ? (
          <div className="agent-policy-tool-empty" data-testid="agent-policy-tool-empty">
            {t("agentPolicy.noExactToolOverrides", "No exact tool overrides configured.")}
          </div>
        ) : (
          <div className="agent-policy-tool-list" data-testid="agent-policy-tool-list">
            {toolRuleEntries.map(([toolName, disposition]) => {
              const inheritedToolDisposition = projectDefaultToolRules?.[toolName];
              return (
                <div className="agent-policy-tool-row" key={toolName} data-testid="agent-policy-tool-row">
                  <label>
                    <span>{t("agentPolicy.toolName", "Tool name")}</span>
                    <input className="input" value={toolName} disabled readOnly />
                  </label>
                  <label>
                    <span>{t("agentPolicy.toolDisposition", "Disposition")}</span>
                    <select
                      className="select"
                      aria-label={t("agentPolicy.toolDispositionFor", "Disposition for {{toolName}}", { toolName })}
                      value={disposition}
                      onChange={(event) => setToolRule(toolName, event.target.value as AgentPermissionPolicyDisposition)}
                      disabled={disabled}
                    >
                      {DISPOSITIONS.map((option) => (
                        <option key={option} value={option}>{getDispositionLabel(t as TFunction<"app">, option)}</option>
                      ))}
                    </select>
                    {mode === "agent-override" && inheritedToolDisposition ? (
                      <small className="agent-policy-inherit-note">
                        {t("agentPolicy.projectDefaultExactTool", "project default exact rule")}: {getDispositionLabel(t as TFunction<"app">, inheritedToolDisposition)}
                      </small>
                    ) : null}
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={t("agentPolicy.removeToolOverride", "Remove exact override for {{toolName}}", { toolName })}
                    onClick={() => removeToolRule(toolName)}
                    disabled={disabled}
                  >
                    {t("agentPolicy.remove", "Remove")}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="agent-policy-tool-add" data-testid="agent-policy-tool-add">
          <label>
            <span>{t("agentPolicy.toolName", "Tool name")}</span>
            <input
              className="input"
              list="agent-policy-known-tools"
              value={pendingToolName}
              onChange={(event) => setPendingToolName(event.target.value)}
              disabled={disabled}
              aria-label={t("agentPolicy.toolOverrideTool", "Tool override tool")}
            />
            <datalist id="agent-policy-known-tools">
              {knownToolOptions.map((toolName) => (
                <option key={toolName} value={toolName} />
              ))}
            </datalist>
          </label>
          <label>
            <span>{t("agentPolicy.toolDisposition", "Disposition")}</span>
            <select
              className="select"
              value={pendingDisposition}
              onChange={(event) => setPendingDisposition(event.target.value as AgentPermissionPolicyDisposition)}
              disabled={disabled}
              aria-label={t("agentPolicy.toolOverrideDisposition", "Tool override disposition")}
            >
              {DISPOSITIONS.map((option) => (
                <option key={option} value={option}>{getDispositionLabel(t as TFunction<"app">, option)}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={addPendingToolRule}
            disabled={disabled || !EXACT_TOOL_NAME_PATTERN.test(pendingToolName.trim())}
          >
            {toolRules[pendingToolName.trim()] ? t("agentPolicy.updateToolOverride", "Update override") : t("agentPolicy.addToolOverride", "Add override")}
          </button>
        </div>
      </section>

      <details className="agent-policy-exempt" open={false}>
        <summary>{t("agentPolicy.exemptTools", "Tools exempt from approval policy")}</summary>
        <p>
          {t("agentPolicy.exemptToolsDescription", "These coordination tools bypass approval policy so heartbeats and inter-agent messaging cannot deadlock. They are not user-configurable.")}
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
