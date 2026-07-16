import type { NodeInfo } from "../../../api";
import { NodeHealthDot } from "../../NodeHealthDot";
import { SettingsSelectRow } from "../SettingsSelectRow";
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
    form: SettingsFormState;
    setForm: SetSettingsForm;
    nodes: NodeInfo[];
}
/*
FNXC:SettingsScope 2026-07-15-17:35:
Both routing settings are project-scoped (DEFAULT_PROJECT_SETTINGS), which is what the note below already tells the operator in prose; the per-row scope badge is the machine-readable form of that same claim.
*/
export function NodeRoutingSection({ form, setForm, nodes }: NodeRoutingSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.nodeRouting.nodeRouting", "Node Routing")}</h4>
      <p className="settings-section-description">{t("settings.nodeRouting.configureHowTasksAreRoutedToExecutionNodes", "Configure how tasks are routed to execution nodes.")}</p>
      <p className="settings-node-routing-note">{t("settings.nodeRouting.theseSettingsApplyAtTheProjectLevel", "These settings apply at the project level.")}</p>
      {/*
      FNXC:SettingsStyling 2026-07-15-17:35:
      This row stays hand-rolled: routing safety requires the live NodeHealthDot for the selected node to sit between the control and its help text, and the shared select row renders only label/control/help with no slot for an adjacent status widget. Forcing it onto the primitive would move or drop the health readout, so the dot wins over row uniformity here.
      */}
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
        <small>{t("settings.nodeRouting.usedWhenATaskHasNoNodeOverride", "Used when a task has no node override. Node status is shown for safer routing selection. No default \u2014 unset (local execution).")}</small>
      </div>
      <SettingsSelectRow
        descriptor={{
          key: "unavailableNodePolicy",
          label: t("settings.nodeRouting.unavailableNodePolicy", "Unavailable Node Policy"),
          help: t("settings.nodeRouting.unavailableNodePolicyHint", "Default: block execution."),
          scope: "project",
          options: [
            { value: "block", label: t("settings.nodeRouting.blockExecution", "Block execution") },
            { value: "fallback-local", label: t("settings.nodeRouting.fallBackToLocal", "Fall back to local") },
          ],
        }}
        value={form.unavailableNodePolicy === "fallback-local" ? "fallback-local" : "block"}
        onChange={(v) => setForm((f) => ({
            ...f,
            unavailableNodePolicy: v as "block" | "fallback-local",
        } as SettingsFormState))}
      />
    </>);
}
export default NodeRoutingSection;
