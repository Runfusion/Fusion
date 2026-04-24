import { useState, useMemo, useCallback, useEffect } from "react";
import { Plus, LayoutGrid, Filter, ArrowUpDown, Activity, CheckCircle, AlertCircle, Folder, Inbox, Server } from "lucide-react";
import type { ProjectInfo, ProjectHealth, NodeInfo, ProjectInfoWithSource } from "../api";
import type { ProjectStatus } from "@fusion/core";
import { ProjectCard } from "./ProjectCard";
import { ProjectGridSkeleton } from "./ProjectGridSkeleton";
import { useProjectHealth } from "../hooks/useProjectHealth";

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
      filtered = filtered.filter(({ project }) => project.nodeId === activeNodeFilter);
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
        case "activity":
          const aTime = a.project.lastActivityAt || a.health?.lastActivityAt || a.project.updatedAt;
          const bTime = b.project.lastActivityAt || b.health?.lastActivityAt || b.project.updatedAt;
          comparison = new Date(bTime).getTime() - new Date(aTime).getTime();
          break;
        case "status":
          const statusOrder: Record<ProjectStatus, number> = {
            errored: 0,
            initializing: 1,
            paused: 2,
            active: 3,
          };
          comparison = statusOrder[a.project.status] - statusOrder[b.project.status];
          break;
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
    const nodesWithProjects = new Set<string | undefined>();
    projects.forEach((p) => {
      if (p.nodeId) {
        nodesWithProjects.add(p.nodeId);
      }
    });
    const totalNodes = nodesWithProjects.size || (totalProjects > 0 ? 1 : 0);

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
    const nodeCounts = new Map<string | undefined, { name: string; count: number }>();
    
    projects.forEach((p) => {
      const nodeId = p.nodeId;
      const existing = nodeCounts.get(nodeId);
      
      if (existing) {
        existing.count++;
      } else {
        // Get the node name from the nodes list or use _sourceNodeName for remote projects
        const localNode = nodes.find((n) => n.id === nodeId);
        const nodeName = localNode?.name ?? p._sourceNodeName ?? "Local";
        nodeCounts.set(nodeId, { name: nodeName, count: 1 });
      }
    });
    
    return Array.from(nodeCounts.entries()).map(([nodeId, { name, count }]) => ({
      nodeId: nodeId ?? null,
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

  // Determine if we need to show skeleton
  // Show skeleton for initial load if:
  // 1. Projects list is still loading, OR
  // 2. Projects exist but we haven't fetched health data yet (healthLoading with no data)
  // Don't show skeleton during background health polling when health data already exists
  const needsInitialSkeleton = loading || (healthLoading && projects.length > 0 && Object.keys(healthMap).length === 0);

  // Show skeleton while loading
  if (needsInitialSkeleton) {
    return <ProjectGridSkeleton />;
  }

  // Empty state when no projects
  if (projects.length === 0) {
    return (
      <div className="project-overview project-overview--empty">
        <div className="project-empty-state">
          <div className="project-empty-state__icon">
            <Inbox size={48} />
          </div>
          <h2 className="project-empty-state__title">No Projects Found</h2>
          <p className="project-empty-state__description">
            Get started by adding your first project. Projects allow you to organize
            and track tasks across multiple repositories.
          </p>
          <button
            className="btn btn-primary project-empty-state__cta"
            onClick={onAddProject}
          >
            <Plus size={16} />
            Add Your First Project
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="project-overview">
      {/* Header with stats */}
      <div className="project-overview__header">
        <h2 className="project-overview__title">
          <LayoutGrid size={20} />
          Projects
        </h2>
        <div className="project-overview__stats">
          <div className="project-stat">
            <div className="project-stat__icon">
              <Folder size={16} />
            </div>
            <div className="project-stat__content">
              <span className="project-stat__value">{stats.totalProjects}</span>
              <span className="project-stat__label">Total</span>
            </div>
          </div>
          <div className="project-stat project-stat--active">
            <div className="project-stat__icon">
              <Activity size={16} />
            </div>
            <div className="project-stat__content">
              <span className="project-stat__value">{stats.totalActiveTasks}</span>
              <span className="project-stat__label">Active Tasks</span>
            </div>
          </div>
          <div className="project-stat project-stat--completed">
            <div className="project-stat__icon">
              <CheckCircle size={16} />
            </div>
            <div className="project-stat__content">
              <span className="project-stat__value">{stats.totalCompletedTasks}</span>
              <span className="project-stat__label">Completed</span>
            </div>
          </div>
          {stats.erroredProjects > 0 && (
            <div className="project-stat project-stat--error">
              <div className="project-stat__icon">
                <AlertCircle size={16} />
              </div>
              <div className="project-stat__content">
                <span className="project-stat__value">{stats.erroredProjects}</span>
                <span className="project-stat__label">Errored</span>
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
                <span className="project-stat__label">Nodes</span>
              </div>
            </div>
          )}
        </div>
        <button
          className="btn btn-primary project-overview__add-btn"
          onClick={onAddProject}
        >
          <Plus size={16} />
          Add Project
        </button>
      </div>

      {/* Filter tabs */}
      <div className="project-overview__filters">
        <div className="project-filter-tabs">
          <button
            className={`project-filter-tab ${activeFilter === "all" ? "active" : ""}`}
            onClick={() => setActiveFilter("all")}
          >
            All
            <span className="project-filter-count">{filterCounts.all}</span>
          </button>
          <button
            className={`project-filter-tab ${activeFilter === "active" ? "active" : ""}`}
            onClick={() => setActiveFilter("active")}
          >
            Active
            <span className="project-filter-count">{filterCounts.active}</span>
          </button>
          <button
            className={`project-filter-tab ${activeFilter === "paused" ? "active" : ""}`}
            onClick={() => setActiveFilter("paused")}
          >
            Paused
            <span className="project-filter-count">{filterCounts.paused}</span>
          </button>
          <button
            className={`project-filter-tab ${activeFilter === "errored" ? "active" : ""} ${filterCounts.errored > 0 ? "has-errors" : ""}`}
            onClick={() => setActiveFilter("errored")}
          >
            Errored
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
              aria-label="Filter by node"
            >
              <option value="">All Nodes</option>
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
            aria-label="Sort projects"
          >
            <option value="activity-desc">Last Activity (Newest)</option>
            <option value="activity-asc">Last Activity (Oldest)</option>
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
            <option value="status-asc">Status (Error → Active)</option>
            <option value="status-desc">Status (Active → Error)</option>
          </select>
          <ArrowUpDown size={14} />
        </div>
      </div>

      {/* Project grid */}
      <div className="project-grid">
        {sortedProjects.map(({ project, health }) => {
          const projectNode = nodes.find((node) => node.id === project.nodeId);
          // Fallback: use server-provided _sourceNodeName for remote projects
          const nodeNameFallback = !projectNode ? project._sourceNodeName : undefined;
          return (
            <ProjectCard
              key={project.id}
              project={project}
              health={health}
              node={projectNode}
              nodeNameFallback={nodeNameFallback}
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
          <p>No projects match the current filter</p>
          <button
            className="btn btn-secondary"
            onClick={() => setActiveFilter("all")}
          >
            Show All Projects
          </button>
        </div>
      )}
    </div>
  );
}
