import { AGENT_PERMISSION_POLICY_ACTION_CATEGORIES } from "@fusion/core";
import type { AgentPermissionPolicy, AgentPermissionPolicyRules } from "@fusion/core";
import { AgentPermissionPolicyEditor } from "../../AgentPermissionPolicyEditor";
import { AgentProvisioningPolicyEditor } from "../../AgentProvisioningPolicyEditor";
import type { SectionBaseProps } from "./context";
import { SettingsHelpTip } from "../SettingsHelpTip";
import { useTranslation } from "react-i18next";
function toCompleteAgentPermissionRules(rules?: Partial<AgentPermissionPolicyRules>): AgentPermissionPolicyRules {
    return AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.reduce((acc, category) => {
        acc[category] = rules?.[category] ?? "allow";
        return acc;
    }, {} as AgentPermissionPolicyRules);
}
export type AgentPermissionsSectionProps = SectionBaseProps;
export function AgentPermissionsSection({ form, setForm }: AgentPermissionsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance \u2014 operator requirement: no inline description paragraphs in Settings. These are block-level descriptions of whole editor groups, so each tip sits beside its section heading. */}
      <div className="settings-field-label-row">
        <h4 className="settings-section-heading">{t("settings.agentPermissions.agentPermissions", "Agent Permissions")}</h4>
        <SettingsHelpTip settingKey="defaultAgentPermissionPolicy">{t("settings.agentPermissions.perAgentSettingsOverrideProjectDefaultsEachCategory", "Project defaults apply to permanent agents, ephemeral task workers, and fallback executor workers unless a per-agent override is set. Exact tool rules compose with the legacy ephemeral create-task toggle. Default: unset \u2014 every action category defaults to allow until a category is explicitly restricted.")}</SettingsHelpTip>
      </div>
      <AgentPermissionPolicyEditor mode="project-default" value={form.defaultAgentPermissionPolicy ? { presetId: "custom", rules: toCompleteAgentPermissionRules(form.defaultAgentPermissionPolicy.rules), ...(form.defaultAgentPermissionPolicy.toolRules ? { toolRules: form.defaultAgentPermissionPolicy.toolRules } : {}) } as AgentPermissionPolicy : { presetId: "custom", rules: toCompleteAgentPermissionRules() }} onChange={(next) => setForm((f) => ({
            ...f,
            defaultAgentPermissionPolicy: { rules: toCompleteAgentPermissionRules(next?.rules), ...(next?.toolRules ? { toolRules: next.toolRules } : {}) },
        }))}/>

      <div className="settings-field-label-row">
        <h4 className="settings-section-heading">{t("settings.agentPermissions.agentProvisioningApprovals", "Agent Provisioning Approvals")}</h4>
        <SettingsHelpTip settingKey="agentProvisioning">{t("settings.agentPermissions.configureProjectLevelApprovalBehaviorForDurableProvisioning", " Configure project-level approval behavior for durable provisioning tools (fn_agent_create/fn_agent_delete). Default: no approval policy configured (empty). ")}</SettingsHelpTip>
      </div>
      <AgentProvisioningPolicyEditor value={form.agentProvisioning} onChange={(next) => setForm((f) => ({ ...f, agentProvisioning: next }))}/>
    </>);
}
export default AgentPermissionsSection;
