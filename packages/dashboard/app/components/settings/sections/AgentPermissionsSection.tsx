/**
 * Agent Permissions section (U9 / KTD-10).
 *
 * Project-default agent permission policy editor plus the agent provisioning
 * approval policy editor. The rule-completion helper is co-located (pure, used
 * only here). Keys and editor wiring preserved verbatim from the original inline
 * JSX.
 */
import type { ReactNode } from "react";
import { AGENT_PERMISSION_POLICY_ACTION_CATEGORIES } from "@fusion/core";
import type { AgentPermissionPolicyRules } from "@fusion/core";
import { AgentPermissionPolicyEditor } from "../../AgentPermissionPolicyEditor";
import { AgentProvisioningPolicyEditor } from "../../AgentProvisioningPolicyEditor";
import type { SectionBaseProps } from "./context";

function toCompleteAgentPermissionRules(rules?: Partial<AgentPermissionPolicyRules>): AgentPermissionPolicyRules {
  return AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.reduce((acc, category) => {
    acc[category] = rules?.[category] ?? "allow";
    return acc;
  }, {} as AgentPermissionPolicyRules);
}

export interface AgentPermissionsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
}

export function AgentPermissionsSection({ scopeBanner, form, setForm }: AgentPermissionsSectionProps) {
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Agent Permissions</h4>
      <div className="form-group">
        <small className="settings-muted">Per-agent settings override project defaults. Each category controls a separate approval gate.</small>
      </div>
      <AgentPermissionPolicyEditor
        mode="project-default"
        value={form.defaultAgentPermissionPolicy ? { presetId: "custom", rules: toCompleteAgentPermissionRules(form.defaultAgentPermissionPolicy.rules) } : { presetId: "custom", rules: toCompleteAgentPermissionRules() }}
        onChange={(next) =>
          setForm((f) => ({
            ...f,
            defaultAgentPermissionPolicy: { rules: toCompleteAgentPermissionRules(next?.rules) },
          }))
        }
      />

      <h4 className="settings-section-heading">Agent Provisioning Approvals</h4>
      <div className="form-group">
        <small className="settings-muted">
          Configure project-level approval behavior for durable provisioning tools (fn_agent_create/fn_agent_delete).
        </small>
      </div>
      <AgentProvisioningPolicyEditor
        value={form.agentProvisioning}
        onChange={(next) => setForm((f) => ({ ...f, agentProvisioning: next }))}
      />
    </>
  );
}

export default AgentPermissionsSection;
