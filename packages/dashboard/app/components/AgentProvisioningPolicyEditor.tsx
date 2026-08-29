import "./AgentProvisioningPolicyEditor.css";
import { Trans, useTranslation } from "react-i18next";
import {
  AGENT_PROVISIONING_APPROVAL_MODES,
  type AgentProvisioningApprovalMode,
  type ProjectSettings,
} from "@fusion/core";

interface Props {
  value: ProjectSettings["agentProvisioning"] | undefined;
  onChange(next: ProjectSettings["agentProvisioning"] | undefined): void;
  disabled?: boolean;
}

// Note: MODE_LABELS moved into component for i18n access

function tokenizeList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

export function AgentProvisioningPolicyEditor({ value, onChange, disabled = false }: Props) {
  const { t } = useTranslation("app");
  const approvalMode = value?.approvalMode ?? "trusted-only";
  const alwaysApproveDelete = value?.alwaysApproveDelete ?? true;

  const MODE_LABELS: Record<AgentProvisioningApprovalMode, { label: string; description: string }> = {
    always: {
      label: t("agentProvisioning.always", "Always require approval"),
      description: t("agentProvisioning.alwaysDesc", "All fn_agent_create/fn_agent_delete requests require approval unless caller is trusted."),
    },
    "trusted-only": {
      label: t("agentProvisioning.trustedOnly", "Trusted-only"),
      description: t("agentProvisioning.trustedOnlyDesc", "Trusted roles/agent IDs bypass approval; other callers require approval."),
    },
    never: {
      label: t("agentProvisioning.never", "Never require approval"),
      description: t("agentProvisioning.neverDesc", "Allow provisioning without approval for non-privileged callers."),
    },
  };

  const update = (patch: Partial<NonNullable<ProjectSettings["agentProvisioning"]>>) => {
    onChange({ ...(value ?? {}), ...patch });
  };

  return (
    <div className="agent-provisioning-policy-editor card">
      <div className="form-group">
        <label htmlFor="agent-provisioning-approval-mode">{t("agentProvisioning.approvalMode", "Approval mode")}</label>
        <select
          id="agent-provisioning-approval-mode"
          className="select"
          value={approvalMode}
          onChange={(event) => update({ approvalMode: event.target.value as AgentProvisioningApprovalMode })}
          disabled={disabled}
        >
          {AGENT_PROVISIONING_APPROVAL_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode].label}
            </option>
          ))}
        </select>
        <small className="agent-provisioning-policy-help">{MODE_LABELS[approvalMode].description}</small>
      </div>

      <div className="form-group">
        <label className="checkbox-label" htmlFor="agent-provisioning-always-approve-delete">
          <input
            id="agent-provisioning-always-approve-delete"
            type="checkbox"
            checked={alwaysApproveDelete}
            onChange={(event) => update({ alwaysApproveDelete: event.target.checked })}
            disabled={disabled}
          />
          {t("agentProvisioning.alwaysApproveDelete", "Always require approval for fn_agent_delete")}
        </label>
      </div>

      <div className="form-group">
        <label htmlFor="agent-provisioning-trusted-roles">{t("agentProvisioning.trustedRoles", "Trusted roles")}</label>
        <textarea
          id="agent-provisioning-trusted-roles"
          className="input agent-provisioning-policy-textarea"
          value={(value?.trustedRoles ?? []).join(", ")}
          onChange={(event) => update({ trustedRoles: tokenizeList(event.target.value) })}
          disabled={disabled}
          placeholder={t("agentProvisioning.trustedRolesPlaceholder", "reviewer, ceo")}
          rows={2}
        />
      </div>

      <div className="form-group">
        <label htmlFor="agent-provisioning-trusted-agent-ids">{t("agentProvisioning.trustedAgentIds", "Trusted agent IDs")}</label>
        <textarea
          id="agent-provisioning-trusted-agent-ids"
          className="input agent-provisioning-policy-textarea"
          value={(value?.trustedAgentIds ?? []).join(", ")}
          onChange={(event) => update({ trustedAgentIds: tokenizeList(event.target.value) })}
          disabled={disabled}
          placeholder={t("agentProvisioning.trustedAgentIdsPlaceholder", "agent-abc123")}
          rows={2}
        />
      </div>

      <p className="agent-provisioning-policy-help">
        <Trans
          i18nKey="app:agentProvisioning.helpText"
          defaults="These settings govern durable provisioning tools only: <code>fn_agent_create</code> and <code>fn_agent_delete</code>. Ephemeral <code2>fn_spawn_agent</code2> requests stay under the task/agent mutation approval gate (FN-3973)."
          components={{ code: <code />, code2: <code /> }}
        />
      </p>
    </div>
  );
}
