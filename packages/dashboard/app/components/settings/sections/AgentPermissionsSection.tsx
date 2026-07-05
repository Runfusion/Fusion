import type { ReactNode } from "react";
import { AGENT_PERMISSION_POLICY_ACTION_CATEGORIES } from "@fusion/core";
import type { AgentPermissionPolicy, AgentPermissionPolicyRules } from "@fusion/core";
import { AgentPermissionPolicyEditor } from "../../AgentPermissionPolicyEditor";
import { AgentProvisioningPolicyEditor } from "../../AgentProvisioningPolicyEditor";
import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
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
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.agentPermissions.agentPermissions", "Agent Permissions")}</h4>
      <div className="form-group">
        <small className="settings-muted">{t("settings.agentPermissions.perAgentSettingsOverrideProjectDefaultsEachCategory", "Project defaults apply to permanent agents, ephemeral task workers, and fallback executor workers unless a per-agent override is set. Exact tool rules compose with the legacy ephemeral create-task toggle. Default: unset \u2014 every action category defaults to allow until a category is explicitly restricted.")}</small>
      </div>
      <AgentPermissionPolicyEditor mode="project-default" value={form.defaultAgentPermissionPolicy ? { presetId: "custom", rules: toCompleteAgentPermissionRules(form.defaultAgentPermissionPolicy.rules), ...(form.defaultAgentPermissionPolicy.toolRules ? { toolRules: form.defaultAgentPermissionPolicy.toolRules } : {}) } as AgentPermissionPolicy : { presetId: "custom", rules: toCompleteAgentPermissionRules() }} onChange={(next) => setForm((f) => ({
            ...f,
            defaultAgentPermissionPolicy: { rules: toCompleteAgentPermissionRules(next?.rules), ...(next?.toolRules ? { toolRules: next.toolRules } : {}) },
        }))}/>

      <h4 className="settings-section-heading">{t("settings.agentPermissions.agentProvisioningApprovals", "Agent Provisioning Approvals")}</h4>
      <div className="form-group">
        <small className="settings-muted">{t("settings.agentPermissions.configureProjectLevelApprovalBehaviorForDurableProvisioning", " Configure project-level approval behavior for durable provisioning tools (fn_agent_create/fn_agent_delete). Default: no approval policy configured (empty). ")}</small>
      </div>
      <AgentProvisioningPolicyEditor value={form.agentProvisioning} onChange={(next) => setForm((f) => ({ ...f, agentProvisioning: next }))}/>
    </>);
}
export default AgentPermissionsSection;
