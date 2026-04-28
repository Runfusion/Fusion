import { useMemo } from "react";
import type { NodeInfo } from "../api";
import "./ProjectNodeSelector.css";

interface ProjectNodeSelectorProps {
  projectId: string;
  currentNodeId?: string;
  onSelect: (nodeId: string | null) => void;
  nodes: NodeInfo[];
  disabled?: boolean;
}

const STATUS_DOT: Record<NodeInfo["status"], string> = {
  online: "🟢",
  offline: "🔴",
  connecting: "🟡",
  error: "🔴",
};

export function ProjectNodeSelector({
  projectId,
  currentNodeId,
  onSelect,
  nodes,
  disabled = false,
}: ProjectNodeSelectorProps) {
  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes]);

  const selectedValue = currentNodeId ?? "";

  return (
    <label className="project-node-selector" htmlFor={`project-node-selector-${projectId}`}>
      <span className="project-node-selector__label">Runtime Node</span>
      <select
        className="select"
        id={`project-node-selector-${projectId}`}
        value={selectedValue}
        onChange={(event) => {
          const value = event.target.value;
          onSelect(value ? value : null);
        }}
        disabled={disabled}
      >
        <option value="">Auto (no assignment)</option>
        {sortedNodes.map((node) => (
          <option
            key={node.id}
            value={node.id}
            className={node.status === "offline" || node.status === "error" ? "project-node-selector__option--dim" : ""}
          >
            {STATUS_DOT[node.status]} {node.name} ({node.type})
          </option>
        ))}
      </select>
    </label>
  );
}
