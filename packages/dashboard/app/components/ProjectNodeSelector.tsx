import { useMemo } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("app");
  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes]);

  const selectedValue = currentNodeId ?? "";

  return (
    <label className="project-node-selector" htmlFor={`project-node-selector-${projectId}`}>
      <span className="project-node-selector__label">{t("nodes.runtimeNodeLabel", "Runtime Node")}</span>
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
        <option value="">{t("nodes.autoAssignment", "Auto (no assignment)")}</option>
        {sortedNodes.map((node) => (
          <option
            key={node.id}
            value={node.id}
            title={t("nodes.statusTitle", "Status: {{status}}", { status: node.status })}
            className={node.status === "offline" || node.status === "error" ? "project-node-selector__option--dim" : ""}
          >
            {t("nodes.nodeLabel", "{{name}} ({{type}}) — {{status}}", { name: node.name, type: node.type, status: node.status })}
          </option>
        ))}
      </select>
    </label>
  );
}
