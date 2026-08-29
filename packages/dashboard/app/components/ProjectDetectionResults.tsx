import { useState, useCallback, useMemo } from "react";
import { Folder, Check, AlertCircle, Edit2, CheckCheck, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DetectedProject } from "../api";
import { sortDetectedProjects } from "../utils/projectDetection";

export interface ProjectDetectionResultsProps {
  /** Detected projects from the scan */
  detectedProjects: DetectedProject[];
  /** Called when a project is selected/deselected */
  onSelect: (project: DetectedProject, selected: boolean) => void;
  /** Called when the name of a detected project is edited */
  onEditName: (index: number, newName: string) => void;
  /** Called when register selected button is clicked */
  onRegisterSelected: (projects: DetectedProject[]) => void;
  /** Loading state during registration */
  isRegistering?: boolean;
}

/**
 * ProjectDetectionResults - Auto-detect results UI
 * 
 * Displays detected projects with:
 * - Checkboxes for selection
 * - Editable names
 * - Warnings for projects without fn database
 * - Register Selected / Register All buttons
 */
export function ProjectDetectionResults({
  detectedProjects,
  onSelect,
  onEditName,
  onRegisterSelected,
  isRegistering = false,
}: ProjectDetectionResultsProps) {
  const { t } = useTranslation("app");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  // Sort projects: existing ones first
  const sortedProjects = useMemo(() => {
    return sortDetectedProjects(detectedProjects);
  }, [detectedProjects]);

  // Calculate selection state
  const selectedCount = selectedPaths.size;
  const allSelected = selectedCount === sortedProjects.length && sortedProjects.length > 0;

  // Toggle selection for a single project
  const toggleSelection = useCallback((project: DetectedProject) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(project.path)) {
        next.delete(project.path);
        onSelect(project, false);
      } else {
        next.add(project.path);
        onSelect(project, true);
      }
      return next;
    });
  }, [onSelect]);

  // Select/deselect all
  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedPaths(new Set());
      sortedProjects.forEach((p) => onSelect(p, false));
    } else {
      const allPaths = new Set(sortedProjects.map((p) => p.path));
      setSelectedPaths(allPaths);
      sortedProjects.forEach((p) => onSelect(p, true));
    }
  }, [allSelected, sortedProjects, onSelect]);

  // Start editing a name
  const startEditing = useCallback((index: number, currentName: string) => {
    setEditingIndex(index);
    setEditValue(currentName);
  }, []);

  // Save edited name
  const saveEdit = useCallback(() => {
    if (editingIndex !== null) {
      onEditName(editingIndex, editValue.trim() || sortedProjects[editingIndex].suggestedName);
      setEditingIndex(null);
      setEditValue("");
    }
  }, [editingIndex, editValue, onEditName, sortedProjects]);

  // Cancel editing
  const cancelEdit = useCallback(() => {
    setEditingIndex(null);
    setEditValue("");
  }, []);

  // Handle register selected
  const handleRegisterSelected = useCallback(() => {
    const selected = sortedProjects.filter((p) => selectedPaths.has(p.path));
    onRegisterSelected(selected);
  }, [sortedProjects, selectedPaths, onRegisterSelected]);

  // Handle register all
  const handleRegisterAll = useCallback(() => {
    onRegisterSelected(sortedProjects);
  }, [sortedProjects, onRegisterSelected]);

  if (sortedProjects.length === 0) {
    return (
      <div className="detection-results detection-results--empty">
        <AlertCircle size={48} />
        <p>{t("projectDetection.empty", "No projects detected")}</p>
        <span className="detection-results-hint">
          {t("projectDetection.emptyHint", "Try a different base path or add a project manually")}
        </span>
      </div>
    );
  }

  return (
    <div className="detection-results">
      {/* Header with select all */}
      <div className="detection-results-header">
        <label className="select-all-checkbox">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            disabled={isRegistering}
          />
          <span>{t("projectDetection.selectAll", "Select All ({{count}})", { count: sortedProjects.length })}</span>
        </label>
        <span className="detection-results-count">
          {t("projectDetection.selectedCount", "{{count}} selected", { count: selectedCount })}
        </span>
      </div>

      {/* Project list */}
      <div className="detection-results-list">
        {sortedProjects.map((project, index) => {
          const isSelected = selectedPaths.has(project.path);
          const isEditing = editingIndex === index;
          const hasKbDb = project.existing;

          return (
            <div
              key={project.path}
              className={`detection-result-item ${isSelected ? "selected" : ""} ${!hasKbDb ? "warning" : ""}`}
            >
              <div className="detection-result-checkbox">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelection(project)}
                  disabled={isRegistering}
                />
              </div>

              <div className="detection-result-icon">
                <Folder size={18} />
                {hasKbDb && <Check size={10} className="existing-badge" />}
              </div>

              <div className="detection-result-content">
                {isEditing ? (
                  <div className="detection-result-edit">
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      autoFocus
                    />
                    <button
                      className="btn btn-sm"
                      onClick={saveEdit}
                      title={t("actions.save", "Save")}
                    >
                      <Check size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="detection-result-name">
                    <span>{project.suggestedName}</span>
                    <button
                      className="btn btn-icon btn-sm"
                      onClick={() => startEditing(index, project.suggestedName)}
                      title={t("projectDetection.editName", "Edit name")}
                      disabled={isRegistering}
                    >
                      <Edit2 />
                    </button>
                  </div>
                )}

                <div className="detection-result-path" title={project.path}>
                  {project.path}
                </div>

                {!hasKbDb && (
                  <div className="detection-result-warning">
                    <AlertCircle size={12} />
                    <span>{t("projectDetection.noDbWarning", "No fn database found - will be initialized")}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="detection-results-actions">
        <button
          className="btn btn-secondary"
          onClick={handleRegisterAll}
          disabled={isRegistering || sortedProjects.length === 0}
        >
          {isRegistering ? (
            <>
              <Loader2 size={14} className="spin" />
              {t("projectDetection.registering", "Registering...")}
            </>
          ) : (
            <>
              <CheckCheck size={14} />
              {t("projectDetection.registerAll", "Register All")}
            </>
          )}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleRegisterSelected}
          disabled={isRegistering || selectedCount === 0}
        >
          {isRegistering ? (
            <>
              <Loader2 size={14} className="spin" />
              {t("projectDetection.registering", "Registering...")}
            </>
          ) : (
            <>
              <Check size={14} />
              {t("projectDetection.registerSelected", "Register Selected ({{count}})", { count: selectedCount })}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
