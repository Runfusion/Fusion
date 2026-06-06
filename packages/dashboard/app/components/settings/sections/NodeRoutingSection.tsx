/**
 * Node Routing section (U9 / KTD-10).
 *
 * Project-scoped execution-node default + unavailable-node policy. The node list
 * is fetched in the shell (shared with other surfaces) and passed down. Keys,
 * node-status rendering, and the inline status label helper are preserved
 * verbatim from the original inline JSX.
 */
import type { ReactNode } from "react";
import type { NodeInfo } from "../../../api";
import { NodeHealthDot } from "../../NodeHealthDot";
import type { SettingsFormState, SetSettingsForm } from "./context";

function getNodeStatusLabel(status: "online" | "offline" | "connecting" | "error"): string {
  if (status === "online") return "Online";
  if (status === "connecting") return "Connecting";
  if (status === "error") return "Error";
  return "Offline";
}

export interface NodeRoutingSectionProps {
  scopeBanner: ReactNode;
  form: SettingsFormState;
  setForm: SetSettingsForm;
  nodes: NodeInfo[];
}

export function NodeRoutingSection({ scopeBanner, form, setForm, nodes }: NodeRoutingSectionProps) {
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Node Routing</h4>
      <p className="settings-section-description">Configure how tasks are routed to execution nodes.</p>
      <p className="settings-node-routing-note">These settings apply at the project level.</p>
      <div className="form-group">
        <label htmlFor="defaultNodeId">Default Execution Node</label>
        <select
          id="defaultNodeId"
          className="select"
          value={typeof form.defaultNodeId === "string" ? form.defaultNodeId : ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, defaultNodeId: val || undefined } as SettingsFormState));
          }}
        >
          <option value="">Local execution (no default node)</option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.name} ({getNodeStatusLabel(node.status)})
            </option>
          ))}
        </select>
        {(() => {
          const selectedNode = nodes.find((node) => node.id === form.defaultNodeId);
          if (!selectedNode) return null;
          return (
            <div className="settings-node-status">
              <span>Selected node:</span>
              <NodeHealthDot status={selectedNode.status} showLabel />
            </div>
          );
        })()}
        <small>Used when a task has no node override. Node status is shown for safer routing selection.</small>
      </div>
      <div className="form-group">
        <label htmlFor="unavailableNodePolicy">Unavailable Node Policy</label>
        <select
          id="unavailableNodePolicy"
          className="select"
          value={
            form.unavailableNodePolicy === "fallback-local" ? "fallback-local" : "block"
          }
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              unavailableNodePolicy: e.target.value as "block" | "fallback-local",
            } as SettingsFormState))
          }
        >
          <option value="block">Block execution</option>
          <option value="fallback-local">Fall back to local</option>
        </select>
      </div>
    </>
  );
}

export default NodeRoutingSection;
