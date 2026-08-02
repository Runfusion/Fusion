import { useState, useMemo, useCallback, useEffect } from "react";
import { Plus, LayoutGrid, Filter, ArrowUpDown, Activity, CheckCircle, AlertCircle, Folder, Inbox, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./ProjectOverview.css";
import type { ProjectInfo, ProjectHealth, NodeInfo, ProjectInfoWithSource, ProjectNodeAvailability } from "../api";
import type { ProjectStatus } from "@fusion/core";
import { ProjectCard } from "./ProjectCard";
import { getNodeMappingsForProject, resolveNodeDisplayName } from "../utils/nodeProjectAssignment";
import { ProjectGridSkeleton } from "./ProjectGridSkeleton";
import { useProjectHealth } from "../hooks/useProjectHealth";
import { ViewHeader } from "./ViewHeader";

export interface ProjectOverviewProps {
  projects: ProjectInfoWithSource[];
  loading?: boolean;
  onSelectProject: (project: ProjectInfo) => void;
  onAddProject: () => void;
  onPauseProject: (project: ProjectInfo) => void;
  onResumeProject: (project: ProjectInfo) => void;
  onRemoveProject: (project: ProjectInfo) => void;
  onViewAllProjects?: () => void;
  nodes?: NodeInfo[];
}

type FilterTab = "all" | "active" | "paused" | "errored";
type SortOption = "name" | "activity" | "status";

interface ProjectWithHealth {
  project: ProjectInfoWithSource;
  health: ProjectHealth | null;
}

interface DisplayMapping extends ProjectNodeAvailability {
  displayName: string;
}

/**
 * ProjectOverview - Multi-project grid view with stats and filtering
 * 
 * Displays all projects in a responsive grid with:
 * - Header stats: total projects, active tasks, completed tasks
 * - Filter tabs: All, Active, Paused, Errored
 * - Sort dropdown: Name, Last Activity, Status
 * - Project cards with health indicators
 * - Empty state when no projects
 */
export function ProjectOverview({
  projects,
  loading = false,
  onSelectProject,
  onAddProject,
  onPauseProject,
  onResumeProject,
  onRemoveProject,
  nodes = [],
}: ProjectOverviewProps) {
  const { t } = useTranslation("app");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [activeNodeFilter, setActiveNodeFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>("activity");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  // Track recently accessed projects for quick selection
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    // Load recently accessed from localStorage
    const recent = localStorage.getItem("kb-dashboard-recent-projects");
    if (recent) {
      try {
        const parsed = JSON.parse(recent) as string[];
        setRecentProjectIds(parsed);
      } catch {
        // Ignore parse errors
      }
    }
  }, []);

  const [recentProjectIds, setRecentProjectIds] = useState<string[]>([]);

  // Fetch health for all projects
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const { healthMap, loading: healthLoading } = useProjectHealth(projectIds);

  // Combine projects with their health data
  const projectsWithHealth: ProjectWithHealth[] = useMemo(() => {
    return projects.map((project) => ({
      project,
      health: healthMap[project.id] || null,
    }));
  }, [projects, healthMap]);

  // Filter projects
  const filteredProjects = useMemo(() => {
    let filtered = [...projectsWithHealth];

    if (activeFilter !== "all") {
      filtered = filtered.filter(({ project }) => project.status === activeFilter);
    }

    // Filter by node if a node filter is active
    if (activeNodeFilter !== null) {
      filtered = filtered.filter(({ project }) => getNodeMappingsForProject(project).some((mapping) => mapping.available && mapping.nodeId === activeNodeFilter));
    }

    return filtered;
  }, [projectsWithHealth, activeFilter, activeNodeFilter]);

  // Sort projects
  const sortedProjects = useMemo(() => {
    const sorted = [...filteredProjects];

    sorted.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case "name":
          comparison = a.project.name.localeCompare(b.project.name);
          break;
        case "activity": {
          const aTime = a.project.lastActivityAt || a.health?.lastActivityAt || a.project.updatedAt;
          const bTime = b.project.lastActivityAt || b.health?.lastActivityAt || b.project.updatedAt;
          comparison = new Date(bTime).getTime() - new Date(aTime).getTime();
          break;
        }
        case "status": {
          const statusOrder: Record<ProjectStatus, number> = {
            errored: 0,
            initializing: 1,
            paused: 2,
            active: 3,
          };
          const aOrder = statusOrder[a.project.status] ?? Number.MAX_SAFE_INTEGER;
          const bOrder = statusOrder[b.project.status] ?? Number.MAX_SAFE_INTEGER;
          comparison = aOrder - bOrder;
          break;
        }
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return sorted;
  }, [filteredProjects, sortBy, sortDirection]);

  // Calculate stats
  const stats = useMemo(() => {
    const totalProjects = projects.length;
    const activeProjects = projects.filter((p) => p.status === "active").length;
    const erroredProjects = projects.filter((p) => p.status === "errored").length;

    // Count unique nodes with projects (local + remote)
    const nodesWithProjects = new Set<string>();
    projects.forEach((project) => {
      getNodeMappingsForProject(project).forEach((mapping) => {
        if (mapping.available) {
          nodesWithProjects.add(mapping.nodeId);
        }
      });
    });
    const totalNodes = nodesWithProjects.size;

    let totalActiveTasks = 0;
    let totalCompletedTasks = 0;
    let totalInFlightAgents = 0;

    Object.values(healthMap).forEach((health) => {
      if (health) {
        totalActiveTasks += health.activeTaskCount;
        totalCompletedTasks += health.totalTasksCompleted;
        totalInFlightAgents += health.inFlightAgentCount;
      }
    });

    return {
      totalProjects,
      activeProjects,
      erroredProjects,
      totalNodes,
      totalActiveTasks,
      totalCompletedTasks,
      totalInFlightAgents,
    };
  }, [projects, healthMap]);

  // Filter counts
  const filterCounts = useMemo(() => {
    return {
      all: projects.length,
      active: projects.filter((p) => p.status === "active").length,
      paused: projects.filter((p) => p.status === "paused").length,
      errored: projects.filter((p) => p.status === "errored").length,
    };
  }, [projects]);

  // Node filter options with project counts
  const nodeFilterOptions = useMemo(() => {
    const nodeCounts = new Map<string, { name: string; count: number }>();

    projects.forEach((project) => {
      getNodeMappingsForProject(project)
        .filter((mapping) => mapping.available)
        .forEach((mapping) => {
          const nodeId = mapping.nodeId;
          const existing = nodeCounts.get(nodeId);
          const resolvedName = resolveNodeDisplayName(nodeId, mapping, nodes, project);
          if (existing) {
            existing.count += 1;
          } else {
            nodeCounts.set(nodeId, { name: resolvedName, count: 1 });
          }
        });
    });

    return Array.from(nodeCounts.entries()).map(([nodeId, { name, count }]) => ({
      nodeId,
      name,
      count,
    }));
  }, [projects, nodes]);

  // Handle project selection
  const handleSelectProject = useCallback((project: ProjectInfo) => {
    // Update recent projects in localStorage
    const updated = [project.id, ...recentProjectIds.filter((id) => id !== project.id)].slice(0, 3);
    setRecentProjectIds(updated);
    if (typeof window !== "undefined") {
      localStorage.setItem("kb-dashboard-recent-projects", JSON.stringify(updated));
    }
    onSelectProject(project);
  }, [onSelectProject, recentProjectIds]);

  /*
  FNXC:ProjectOverviewHealthHydration 2026-08-01-15:40:
  Registered project metadata and controls are the navigation-critical surface, while health is optional,
  potentially slow per-project telemetry. Keep the grid visible as soon as the list resolves; cards mark only
  their own pending health rather than replacing the whole overview until every batch has completed.
  */
  const needsInitialSkeleton = loading;
  /*
  FNXC:DashboardHeader 2026-06-22-16:42:
  The Project Dashboard overview (projects, stats, filters, and charts/overview content) owns the shared top header. The Board view must stay headerless because its columns already consume the full board surface.

  FNXC:DashboardNaming 2026-06-22-20:08:
  The analytics Command Center surface is now labeled Dashboard, so this older projects overview is labeled Project Dashboard to avoid two visible Dashboard destinations.
  */
  const dashboardHeader = (
    <ViewHeader
      icon={LayoutGrid}
      title={t("dashboard.title", "Project Dashboard")}
      actions={(
        <button
          className="btn btn-primary btn-sm project-overview__add-btn"
          onClick={onAddProject}
        >
          <Plus size={14} />
          {t("projects.addProject", "Add Project")}
        </button>
      )}
    />
  );

  // Show skeleton while loading
  if (needsInitialSkeleton) {
    return (
      <div className="project-overview">
        {dashboardHeader}
        <div className="project-overview__body">
          <ProjectGridSkeleton />
        </div>
      </div>
    );
  }

  // Empty state when no projects
  if (projects.length === 0) {
    return (
      <div className="project-overview">
        {dashboardHeader}
        <div className="project-overview__body project-overview__body--empty">
          <div className="project-empty-state">
            <div className="project-empty-state__icon">
              <Inbox size={48} />
            </div>
            <h2 className="project-empty-state__title">{t("projects.noProjectsFound", "No Projects Found")}</h2>
            <p className="project-empty-state__description">
              {t("projects.emptyStateDescription", "Get started by adding your first project. Projects allow you to organize and track tasks across multiple repositories.")}
            </p>
            <button
              className="btn btn-primary project-empty-state__cta"
              onClick={onAddProject}
            >
              <Plus size={16} />
              {t("projects.addFirstProject", "Add Your First Project")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="project-overview">
      {dashboardHeader}
      <div className="project-overview__body">
      {/* Header with stats */}
      <div className="project-overview__header">
        <div className="project-overview__stats">
          <div className="project-stat">
            <div className="project-stat__icon">
              <Folder size={16} />
            </div>
            <div className="project-stat__content">
              <span className="project-stat__value">{stats.totalProjects}</span>
              <span className="project-stat__label">{t("projects.totalLabel", "Total")}</span>
            </div>
          </div>
          <div className="project-stat project-stat--active">
            <div className="project-stat__icon">
              <Activity size={16} />
            </div>
            <div className="project-stat__content">
              <span className="project-stat__value">{stats.totalActiveTasks}</span>
              <span className="project-stat__label">{t("projects.activeTasksLabel", "Active Tasks")}</span>
            </div>
          </div>
          <div className="project-stat project-stat--completed">
            <div className="project-stat__icon">
              <CheckCircle size={16} />
            </div>
            <div className="project-stat__content">
              <span className="project-stat__value">{stats.totalCompletedTasks}</span>
              <span className="project-stat__label">{t("projects.completedLabel", "Completed")}</span>
            </div>
          </div>
          {stats.erroredProjects > 0 && (
            <div className="project-stat project-stat--error">
              <div className="project-stat__icon">
                <AlertCircle size={16} />
              </div>
              <div className="project-stat__content">
                <span className="project-stat__value">{stats.erroredProjects}</span>
                <span className="project-stat__label">{t("projects.erroredLabel", "Errored")}</span>
              </div>
            </div>
          )}
          {stats.totalNodes > 1 && (
            <div className="project-stat project-stat--nodes">
              <div className="project-stat__icon">
                <Server size={16} />
              </div>
              <div className="project-stat__content">
                <span className="project-stat__value">{stats.totalNodes}</span>
                <span className="project-stat__label">{t("projects.nodesLabel", "Nodes")}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="project-overview__filters">
        <div className="project-filter-tabs">
          <button
            className={`project-filter-tab ${activeFilter === "all" ? "active" : ""}`}
            onClick={() => setActiveFilter("all")}
          >
            {t("projects.filterAll", "All")}
            <span className="project-filter-count">{filterCounts.all}</span>
          </button>
          <button
            className={`project-filter-tab ${activeFilter === "active" ? "active" : ""}`}
            onClick={() => setActiveFilter("active")}
          >
            {t("projects.filterActive", "Active")}
            <span className="project-filter-count">{filterCounts.active}</span>
          </button>
          <button
            className={`project-filter-tab ${activeFilter === "paused" ? "active" : ""}`}
            onClick={() => setActiveFilter("paused")}
          >
            {t("projects.filterPaused", "Paused")}
            <span className="project-filter-count">{filterCounts.paused}</span>
          </button>
          <button
            className={`project-filter-tab ${activeFilter === "errored" ? "active" : ""} ${filterCounts.errored > 0 ? "has-errors" : ""}`}
            onClick={() => setActiveFilter("errored")}
          >
            {t("projects.filterErrored", "Errored")}
            <span className="project-filter-count">{filterCounts.errored}</span>
          </button>
        </div>

        {/* Node filter dropdown */}
        {nodeFilterOptions.length > 1 && (
          <div className="project-node-filter">
            <Server size={14} />
            <select
              value={activeNodeFilter ?? ""}
              onChange={(e) => {
                setActiveNodeFilter(e.target.value || null);
              }}
              className="project-node-filter-select"
              aria-label={t("projects.filterByNode", "Filter by node")}
            >
              <option value="">{t("projects.allNodes", "All Nodes")}</option>
              {nodeFilterOptions.map(({ nodeId, name, count }) => (
                <option key={nodeId ?? "local"} value={nodeId ?? ""}>
                  {name} ({count})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Sort dropdown */}
        <div className="project-sort">
          <Filter size={14} />
          <select
            value={`${sortBy}-${sortDirection}`}
            onChange={(e) => {
              const [newSort, newDir] = e.target.value.split("-") as [SortOption, "asc" | "desc"];
              setSortBy(newSort);
              setSortDirection(newDir);
            }}
            className="project-sort-select"
            aria-label={t("projects.sortProjects", "Sort projects")}
          >
            <option value="activity-desc">{t("projects.sortActivityNewest", "Last Activity (Newest)")}</option>
            <option value="activity-asc">{t("projects.sortActivityOldest", "Last Activity (Oldest)")}</option>
            <option value="name-asc">{t("projects.sortNameAsc", "Name (A-Z)")}</option>
            <option value="name-desc">{t("projects.sortNameDesc", "Name (Z-A)")}</option>
            <option value="status-asc">{t("projects.sortStatusAsc", "Status (Error → Active)")}</option>
            <option value="status-desc">{t("projects.sortStatusDesc", "Status (Active → Error)")}</option>
          </select>
          <ArrowUpDown size={14} />
        </div>
      </div>

      {/* Project grid */}
      <div className="project-grid">
        {sortedProjects.map(({ project, health }) => {
          const healthPending = healthLoading && !Object.hasOwn(healthMap, project.id);
          const availabilityMappings: DisplayMapping[] = getNodeMappingsForProject(project)
            .filter((mapping) => mapping.available)
            .map((mapping) => ({
              ...mapping,
              displayName: resolveNodeDisplayName(mapping.nodeId, mapping, nodes, project),
            }));

          return (
            <ProjectCard
              key={project.id}
              project={project}
              health={health}
              healthLoading={healthPending}
              availabilityMappings={availabilityMappings}
              onSelect={handleSelectProject}
              onPause={onPauseProject}
              onResume={onResumeProject}
              onRemove={onRemoveProject}
            />
          );
        })}
      </div>

      {/* No results state */}
      {sortedProjects.length === 0 && (
        <div className="project-overview__no-results">
          <Filter size={32} />
          <p>{t("projects.noMatch", "No projects match the current filter")}</p>
          <button
            className="btn btn-secondary"
            onClick={() => setActiveFilter("all")}
          >
            {t("projects.showAll", "Show All Projects")}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
