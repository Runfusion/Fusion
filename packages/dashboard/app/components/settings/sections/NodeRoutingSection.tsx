import type { ReactNode } from "react";
import type { NodeInfo } from "../../../api";
import { NodeHealthDot } from "../../NodeHealthDot";
import type { SettingsFormState, SetSettingsForm } from "./context";
import { useTranslation } from "react-i18next";
function getNodeStatusLabel(status: "online" | "offline" | "connecting" | "error", t: ReturnType<typeof useTranslation<"app">>["t"]): string {
    if (status === "online")
        return t("settings.nodeRouting.statusOnline", "Online");
    if (status === "connecting")
        return t("settings.nodeRouting.statusConnecting", "Connecting");
    if (status === "error")
        return t("settings.nodeRouting.statusError", "Error");
    return t("settings.nodeRouting.statusOffline", "Offline");
}
export interface NodeRoutingSectionProps {
    scopeBanner: ReactNode;
    form: SettingsFormState;
    setForm: SetSettingsForm;
    nodes: NodeInfo[];
}
export function NodeRoutingSection({ scopeBanner, form, setForm, nodes }: NodeRoutingSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.nodeRouting.nodeRouting", "Node Routing")}</h4>
      <p className="settings-section-description">{t("settings.nodeRouting.configureHowTasksAreRoutedToExecutionNodes", "Configure how tasks are routed to execution nodes.")}</p>
      <p className="settings-node-routing-note">{t("settings.nodeRouting.theseSettingsApplyAtTheProjectLevel", "These settings apply at the project level.")}</p>
      <div className="form-group">
        <label htmlFor="defaultNodeId">{t("settings.nodeRouting.defaultExecutionNode", "Default Execution Node")}</label>
        <select id="defaultNodeId" className="select" value={typeof form.defaultNodeId === "string" ? form.defaultNodeId : ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, defaultNodeId: val || undefined } as SettingsFormState));
        }}>
          <option value="">{t("settings.nodeRouting.localExecutionNoDefaultNode", "Local execution (no default node)")}</option>
          {nodes.map((node) => (<option key={node.id} value={node.id}>
              {node.name} ({getNodeStatusLabel(node.status, t)})
            </option>))}
        </select>
        {(() => {
            const selectedNode = nodes.find((node) => node.id === form.defaultNodeId);
            if (!selectedNode)
                return null;
            return (<div className="settings-node-status">
              <span>{t("settings.nodeRouting.selectedNode", "Selected node:")}</span>
              <NodeHealthDot status={selectedNode.status} showLabel/>
            </div>);
        })()}
        <small>{t("settings.nodeRouting.usedWhenATaskHasNoNodeOverride", "Used when a task has no node override. Node status is shown for safer routing selection.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="unavailableNodePolicy">{t("settings.nodeRouting.unavailableNodePolicy", "Unavailable Node Policy")}</label>
        <select id="unavailableNodePolicy" className="select" value={form.unavailableNodePolicy === "fallback-local" ? "fallback-local" : "block"} onChange={(e) => setForm((f) => ({
            ...f,
            unavailableNodePolicy: e.target.value as "block" | "fallback-local",
        } as SettingsFormState))}>
          <option value="block">{t("settings.nodeRouting.blockExecution", "Block execution")}</option>
          <option value="fallback-local">{t("settings.nodeRouting.fallBackToLocal", "Fall back to local")}</option>
        </select>
      </div>
    </>);
}
export default NodeRoutingSection;
