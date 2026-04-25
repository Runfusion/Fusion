import "./ProjectSelector.css";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  ChevronDown,
  Check,
  Folder,
  Grid3X3,
  Search,
  Clock,
  Play,
  Pause,
  AlertCircle,
  Loader2,
  X,
} from "lucide-react";
import type { ProjectInfo } from "../api";
import type { ProjectStatus } from "@fusion/core";

export interface ProjectSelectorProps {
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  onSelect: (project: ProjectInfo) => void;
  onViewAll: () => void;
  recentProjectIds?: string[];
}

const STATUS_CONFIG: Record<ProjectStatus, { color: string; icon: typeof Play }> = {
  active: { color: "var(--success)", icon: Play },
  paused: { color: "var(--warning)", icon: Pause },
  errored: { color: "var(--color-error)", icon: AlertCircle },
  initializing: { color: "var(--info)", icon: Loader2 },
};

/**
 * ProjectSelector - Project switcher dropdown with keyboard navigation
 * 
 * Features:
 * - Dropdown trigger showing current project name + chevron
 * - Dropdown menu with project list, status icons, "View All Projects" option
 * - Keyboard navigation: arrow keys, enter to select, escape to close
 * - Search/filter when 5+ projects
 * - Recent projects section at top (last 3 accessed)
 */
export function ProjectSelector({
  projects,
  currentProject,
  onSelect,
  onViewAll,
  recentProjectIds = [],
}: ProjectSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Focus search input when dropdown opens (if search is visible)
  useEffect(() => {
    if (isOpen && projects.length >= 5) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isOpen, projects.length]);

  // Get recent projects
  const recentProjects = useMemo(() => {
    return recentProjectIds
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is ProjectInfo => p !== undefined && p.id !== currentProject?.id)
      .slice(0, 3);
  }, [recentProjectIds, projects, currentProject]);

  // Filter projects based on search
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.path.toLowerCase().includes(query)
    );
  }, [projects, searchQuery]);

  // Organize projects for display: recent first, then others
  const displayProjects = useMemo(() => {
    const recentIds = new Set(recentProjects.map((p) => p.id));
    const currentId = currentProject?.id;

    // Exclude current project from list
    const others = filteredProjects.filter(
      (p) => p.id !== currentId && !recentIds.has(p.id)
    );

    return {
      recent: searchQuery.trim() ? [] : recentProjects,
      others,
    };
  }, [filteredProjects, recentProjects, currentProject, searchQuery]);

  // Calculate total items for keyboard navigation
  const totalItems = useMemo(() => {
    const recentCount = displayProjects.recent.length;
    const othersCount = displayProjects.others.length;
    const viewAllCount = 1;
    return recentCount + othersCount + viewAllCount;
  }, [displayProjects]);

  // Handle keyboard navigation within dropdown
  const handleDropdownKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < totalItems - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : totalItems - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0) {
            const recentCount = displayProjects.recent.length;
            const othersCount = displayProjects.others.length;

            if (highlightedIndex < recentCount) {
              // Select recent project
              onSelect(displayProjects.recent[highlightedIndex]);
            } else if (highlightedIndex < recentCount + othersCount) {
              // Select other project
              onSelect(displayProjects.others[highlightedIndex - recentCount]);
            } else {
              // View All
              onViewAll();
            }
            setIsOpen(false);
            setSearchQuery("");
          }
          break;
        case "Home":
          e.preventDefault();
          setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setHighlightedIndex(totalItems - 1);
          break;
      }
    },
    [highlightedIndex, totalItems, displayProjects, onSelect, onViewAll]
  );

  // Reset highlight when dropdown opens or search changes
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(-1);
    }
  }, [isOpen, searchQuery]);

  // Handle project selection
  const handleSelectProject = useCallback(
    (project: ProjectInfo) => {
      onSelect(project);
      setIsOpen(false);
      setSearchQuery("");
    },
    [onSelect]
  );

  // Handle view all
  const handleViewAll = useCallback(() => {
    onViewAll();
    setIsOpen(false);
    setSearchQuery("");
  }, [onViewAll]);

  // Toggle dropdown
  const toggleDropdown = useCallback(() => {
    setIsOpen((prev) => !prev);
    if (isOpen) {
      setSearchQuery("");
    }
  }, [isOpen]);

  // Render status icon
  const renderStatusIcon = (status: ProjectStatus) => {
    const config = STATUS_CONFIG[status];
    const Icon = config.icon;
    return (
      <Icon
        size={14}
        style={{ color: config.color }}
        className={status === "initializing" ? "animate-spin" : ""}
      />
    );
  };

  // Don't render if only one project (single-project mode)
  if (projects.length <= 1) {
    return null;
  }

  return (
    <div className="project-selector" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        className={`project-selector__trigger ${isOpen ? "open" : ""}`}
        onClick={toggleDropdown}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Select project"
        data-testid="project-selector-trigger"
      >
        <Folder size={16} className="project-selector__trigger-icon" />
        <span className="project-selector__trigger-text">
          {currentProject?.name || "Select Project"}
        </span>
        <ChevronDown
          size={14}
          className={`project-selector__trigger-chevron ${isOpen ? "rotate" : ""}`}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          className="project-selector__dropdown"
          role="listbox"
          aria-label="Projects"
          onKeyDown={handleDropdownKeyDown}
          data-testid="project-selector-dropdown"
        >
          {/* Search input (shown when 5+ projects) */}
          {projects.length >= 5 && (
            <div className="project-selector__search">
              <Search size={14} className="project-selector__search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search projects..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="project-selector__search-input"
              />
              {searchQuery && (
                <button
                  className="project-selector__search-clear"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          {/* Recent projects section */}
          {displayProjects.recent.length > 0 && (
            <div className="project-selector__section">
              <div className="project-selector__section-header">
                <Clock size={12} />
                <span>Recent</span>
              </div>
              {displayProjects.recent.map((project, index) => (
                <button
                  key={project.id}
                  className={`project-selector__item ${
                    highlightedIndex === index ? "highlighted" : ""
                  }`}
                  onClick={() => handleSelectProject(project)}
                  role="option"
                  aria-selected={currentProject?.id === project.id}
                >
                  {renderStatusIcon(project.status)}
                  <span className="project-selector__item-name">
                    {project.name}
                  </span>
                  {currentProject?.id === project.id && (
                    <Check size={14} className="project-selector__item-check" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* All projects section */}
          <div className="project-selector__section">
            {displayProjects.recent.length > 0 && (
              <div className="project-selector__section-header">
                <Folder size={12} />
                <span>All Projects</span>
              </div>
            )}

            {displayProjects.others.length === 0 && searchQuery ? (
              <div className="project-selector__no-results">
                No projects match your search
              </div>
            ) : (
              displayProjects.others.map((project, index) => {
                const actualIndex = displayProjects.recent.length + index;
                return (
                  <button
                    key={project.id}
                    className={`project-selector__item ${
                      highlightedIndex === actualIndex ? "highlighted" : ""
                    }`}
                    onClick={() => handleSelectProject(project)}
                    role="option"
                    aria-selected={currentProject?.id === project.id}
                  >
                    {renderStatusIcon(project.status)}
                    <div className="project-selector__item-info">
                      <span className="project-selector__item-name">
                        {project.name}
                      </span>
                      <span className="project-selector__item-path">
                        {project.path.split("/").slice(-2).join("/")}
                      </span>
                    </div>
                    {currentProject?.id === project.id && (
                      <Check size={14} className="project-selector__item-check" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* View All option */}
          <div className="project-selector__footer">
            <button
              className={`project-selector__view-all ${
                highlightedIndex === totalItems - 1 ? "highlighted" : ""
              }`}
              onClick={handleViewAll}
            >
              <Grid3X3 size={14} />
              <span>View All Projects</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
