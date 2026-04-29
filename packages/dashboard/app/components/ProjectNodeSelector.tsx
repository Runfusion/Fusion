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
            title={`Status: ${node.status}`}
            className={node.status === "offline" || node.status === "error" ? "project-node-selector__option--dim" : ""}
          >
            {node.name} ({node.type}) — {node.status}
          </option>
        ))}
      </select>
    </label>
  );
}
