import "./RoutingTab.css";
import type { Settings, Task, TaskDetail } from "@fusion/core";

interface RoutingTabProps {
  task: Task | TaskDetail;
  settings?: Settings;
  projectId?: string;
}

export function RoutingTab({ task, settings, projectId }: RoutingTabProps) {
  void projectId;

  return (
    <div className="detail-section routing-tab">
      <h4>Node Routing</h4>
      <dl className="detail-source-grid">
        <div>
          <dt>Task Override</dt>
          <dd>{task.nodeId ?? <span className="detail-source-empty">(none)</span>}</dd>
        </div>
        <div>
          <dt>Effective Node</dt>
          <dd>{(task as Task & { effectiveNodeId?: string }).effectiveNodeId ?? "local execution"}</dd>
        </div>
        <div>
          <dt>Routing Source</dt>
          <dd>{(task as Task & { effectiveNodeSource?: string }).effectiveNodeSource ?? "local"}</dd>
        </div>
        <div>
          <dt>Unavailable Node Policy</dt>
          <dd>{(settings as (Settings & { unavailableNodePolicy?: string }) | undefined)?.unavailableNodePolicy ?? "block"}</dd>
        </div>
        <div>
          <dt>Blocking Reason</dt>
          <dd>
            {((task as Task & { blockedReason?: string; statusReason?: string }).blockedReason ||
              (task as Task & { statusReason?: string }).statusReason) ?? (
              <span className="detail-source-empty">(not blocked)</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
