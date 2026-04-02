# Task: KB-003 - Dashboard Multi-Project UX: Overview page, drill-down, and setup wizard

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This task builds the primary user-facing multi-project interface on top of KB-001's central infrastructure and KB-002's runtime abstractions. Changes involve dashboard routing, new UI components, and API routes. While significant, the patterns are established (React Router, existing modal/dialog patterns, API conventions) and the underlying data models are provided by dependencies.

**Score:** 5/8 — Blast radius: 1 (dashboard only), Pattern novelty: 1 (follows existing UI patterns), Security: 2 (path validation, project isolation), Reversibility: 1 (additive features)

## Mission

Build the dashboard's multi-project user experience that allows users to view, navigate, and manage multiple kb projects from a unified interface. This includes: (1) a Projects Overview page showing all registered projects with at-a-glance status, (2) drill-down navigation into specific projects with project-scoped task views, and (3) a multi-step Project Setup Wizard for registering new projects with path validation and isolation mode selection.

This task consumes the APIs from KB-001 (CentralCoreStore for project registry, Project types) and KB-002 (ProjectRuntime status). The dashboard shifts from a single-project assumption to a multi-project architecture where users first see all projects, then navigate into specific ones.

Key deliverables:
- **Projects Overview Page**: Grid/list view of all projects with status badges, task counts, quick actions
- **Project Drill-Down Navigation**: Route-based navigation to project-specific views with breadcrumbs
- **Project Setup Wizard**: Multi-step flow for registering projects with validation
- **Dashboard API Routes**: REST endpoints for project CRUD and runtime status
- **Project-scoped data fetching**: Tasks API updated to support per-project queries

## Dependencies

- **Task:** KB-001 — CentralCoreStore with `listProjects()`, `registerProject()`, `getProject()` methods; `Project`, `ProjectCreateInput`, `ProjectStatus`, `ProjectIsolationMode` types exported from `@fusion/core`
- **Task:** KB-002 — ProjectRuntimeManager with `getRuntime()`, `getStatus()` methods; runtime status reporting

## Context to Read First

1. `/packages/core/src/types.ts` — Verify `Project`, `ProjectCreateInput`, `ProjectStatus`, `ProjectIsolationMode` types exist (from KB-001)
2. `/packages/core/src/index.ts` — Verify CentralCoreStore is exported and its public API
3. `/packages/dashboard/app/App.tsx` — Current routing structure (SPA with modal-based navigation)
4. `/packages/dashboard/app/api.ts` — Existing API client patterns
5. `/packages/dashboard/src/routes.ts` — Server-side API route patterns
6. `/packages/dashboard/src/server.ts` — Server creation and TaskStore injection
7. `/packages/dashboard/app/components/Header.tsx` — Navigation header patterns
8. `/packages/dashboard/app/hooks/useTasks.ts` — Current task data fetching patterns

## File Scope

### New Files
- `packages/dashboard/app/components/ProjectsOverview.tsx` — Projects grid/list view component
- `packages/dashboard/app/components/ProjectCard.tsx` — Individual project card with status
- `packages/dashboard/app/components/ProjectDetail.tsx` — Project-scoped task board view
- `packages/dashboard/app/components/ProjectSetupWizard.tsx` — Multi-step project creation wizard
- `packages/dashboard/app/components/ProjectBreadcrumb.tsx` — Navigation breadcrumb for project context
- `packages/dashboard/app/hooks/useProjects.ts` — React hook for project data fetching
- `packages/dashboard/app/hooks/useProjectRuntime.ts` — React hook for runtime status
- `packages/dashboard/app/routes.tsx` — React Router configuration with project routes
- `packages/dashboard/src/project-routes.ts` — Server API routes for projects (`GET /api/projects`, `POST /api/projects`, etc.)
- `packages/dashboard/app/components/ProjectsOverview.test.tsx` — Overview page tests
- `packages/dashboard/app/components/ProjectSetupWizard.test.tsx` — Wizard tests

### Modified Files
- `packages/dashboard/app/App.tsx` — Integrate React Router, add project context
- `packages/dashboard/app/api.ts` — Add project API client methods
- `packages/dashboard/src/routes.ts` — Add project API routes delegation
- `packages/dashboard/src/server.ts` — Inject CentralCoreStore alongside TaskStore
- `packages/dashboard/app/components/Header.tsx` — Add project navigation, breadcrumb support
- `packages/dashboard/app/components/Board.tsx` — Support project-scoped task fetching
- `packages/dashboard/app/components/ListView.tsx` — Support project-scoped task fetching
- `packages/dashboard/app/hooks/useTasks.ts` — Add optional `projectId` parameter

## Steps

### Step 0: Preflight

- [ ] Read all Context files listed above
- [ ] **Verify KB-001 APIs exist**: Check that CentralCoreStore has required methods:
  ```bash
  grep -q "listProjects\|registerProject\|getProject" packages/core/src/central-core-store.ts 2>/dev/null && \
  echo "KB-001 APIs verified" || echo "WARNING: KB-001 APIs may not be complete"
  ```
- [ ] **Verify KB-002 types exist**: Check that Project types are exported:
  ```bash
  grep -q "export.*ProjectIsolationMode\|export.*ProjectStatus" packages/core/src/types.ts && \
  echo "KB-002 types verified" || echo "WARNING: Project types may not be complete"
  ```
- [ ] Verify existing tests pass: `pnpm test`
- [ ] Verify build passes: `pnpm build`

### Step 1: Dashboard API Routes for Projects

Create server-side API endpoints that expose CentralCoreStore operations.

- [ ] Create `packages/dashboard/src/project-routes.ts` with route handlers:
  ```typescript
  import { Router } from "express";
  import type { CentralCoreStore } from "@fusion/core";
  
  export function createProjectRoutes(store: CentralCoreStore): Router {
    const router = Router();
    
    // GET /api/projects — List all projects with runtime status
    router.get("/projects", async (_req, res, next) => {
      try {
        const projects = await store.listProjects();
        // Enhance with runtime status if available
        res.json(projects);
      } catch (err) { next(err); }
    });
    
    // POST /api/projects — Register new project
    router.post("/projects", async (req, res, next) => {
      try {
        const input = req.body;
        // Validation: path must exist, be absolute, not already registered
        const project = await store.registerProject(input);
        res.status(201).json(project);
      } catch (err) { next(err); }
    });
    
    // GET /api/projects/:id — Get project details
    router.get("/projects/:id", async (req, res, next) => {
      try {
        const project = await store.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: "Project not found" });
        res.json(project);
      } catch (err) { next(err); }
    });
    
    // PATCH /api/projects/:id — Update project
    router.patch("/projects/:id", async (req, res, next) => {
      try {
        const updates = req.body;
        const project = await store.updateProject(req.params.id, updates);
        res.json(project);
      } catch (err) { next(err); }
    });
    
    // DELETE /api/projects/:id — Unregister project
    router.delete("/projects/:id", async (req, res, next) => {
      try {
        const deleted = await store.unregisterProject(req.params.id);
        res.json({ deleted });
      } catch (err) { next(err); }
    });
    
    // GET /api/projects/:id/status — Get runtime status
    router.get("/projects/:id/status", async (req, res, next) => {
      try {
        // Get runtime from ProjectRuntimeManager (KB-002)
        const status = await runtimeManager.getRuntimeStatus(req.params.id);
        res.json(status);
      } catch (err) { next(err); }
    });
    
    return router;
  }
  ```

- [ ] Modify `packages/dashboard/src/server.ts`:
  - Update `ServerOptions` to accept `centralStore?: CentralCoreStore`
  - Mount project routes: `app.use("/api", createProjectRoutes(centralStore))`
  - Fall back to creating CentralCoreStore if not provided

- [ ] Modify `packages/dashboard/src/routes.ts`:
  - Import and re-export project route utilities
  - Add project routes to the main API (if using combined router approach)

- [ ] Write tests in `packages/dashboard/src/project-routes.test.ts`:
  - GET /api/projects returns array
  - POST /api/projects validates path exists
  - POST /api/projects rejects duplicate paths
  - PATCH /api/projects/:id updates fields
  - DELETE /api/projects/:id unregisters

**Artifacts:**
- `packages/dashboard/src/project-routes.ts` (new)
- `packages/dashboard/src/project-routes.test.ts` (new)
- `packages/dashboard/src/server.ts` (modified — CentralCoreStore injection)

### Step 2: Client API Layer for Projects

Add project API methods to the dashboard client.

- [ ] Modify `packages/dashboard/app/api.ts`:
  - Add imports for `Project`, `ProjectCreateInput` from `@fusion/core`
  - Add functions:
    ```typescript
    export function fetchProjects(): Promise<Project[]> {
      return api<Project[]>("/projects");
    }
    
    export function createProject(input: ProjectCreateInput): Promise<Project> {
      return api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify(input),
      });
    }
    
    export function fetchProject(id: string): Promise<Project> {
      return api<Project>(`/projects/${id}`);
    }
    
    export function updateProject(
      id: string,
      updates: Partial<ProjectCreateInput> & { status?: ProjectStatus }
    ): Promise<Project> {
      return api<Project>(`/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
    }
    
    export function deleteProject(id: string): Promise<{ deleted: boolean }> {
      return api<{ deleted: boolean }>(`/projects/${id}`, {
        method: "DELETE",
      });
    }
    
    export function fetchProjectStatus(id: string): Promise<RuntimeStatus> {
      return api<RuntimeStatus>(`/projects/${id}/status`);
    }
    ```

- [ ] Update `fetchTasks` to accept optional `projectId`:
  ```typescript
  export function fetchTasks(projectId?: string, limit?: number, offset?: number): Promise<Task[]> {
    const search = new URLSearchParams();
    if (projectId) search.set("projectId", projectId);
    if (limit !== undefined) search.set("limit", String(limit));
    if (offset !== undefined) search.set("offset", String(offset));
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return api<Task[]>(`/tasks${suffix}`);
  }
  ```

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified — project API methods)

### Step 3: React Hooks for Projects

Create React hooks for project data fetching and state management.

- [ ] Create `packages/dashboard/app/hooks/useProjects.ts`:
  ```typescript
  import { useState, useEffect, useCallback } from "react";
  import type { Project, ProjectCreateInput } from "@fusion/core";
  import {
    fetchProjects,
    createProject as apiCreateProject,
    updateProject as apiUpdateProject,
    deleteProject as apiDeleteProject,
  } from "../api";
  
  export interface UseProjectsResult {
    projects: Project[];
    loading: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
    createProject: (input: ProjectCreateInput) => Promise<Project>;
    updateProject: (id: string, updates: Parameters<typeof apiUpdateProject>[1]) => Promise<Project>;
    deleteProject: (id: string) => Promise<boolean>;
  }
  
  export function useProjects(): UseProjectsResult {
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    
    const refresh = useCallback(async () => {
      try {
        setLoading(true);
        const data = await fetchProjects();
        setProjects(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    }, []);
    
    useEffect(() => {
      refresh();
    }, [refresh]);
    
    const createProject = useCallback(async (input: ProjectCreateInput) => {
      const project = await apiCreateProject(input);
      await refresh();
      return project;
    }, [refresh]);
    
    const updateProject = useCallback(async (id: string, updates: Parameters<typeof apiUpdateProject>[1]) => {
      const project = await apiUpdateProject(id, updates);
      setProjects(prev => prev.map(p => p.id === id ? project : p));
      return project;
    }, []);
    
    const deleteProject = useCallback(async (id: string) => {
      const result = await apiDeleteProject(id);
      if (result.deleted) {
        setProjects(prev => prev.filter(p => p.id !== id));
      }
      return result.deleted;
    }, []);
    
    return {
      projects,
      loading,
      error,
      refresh,
      createProject,
      updateProject,
      deleteProject,
    };
  }
  ```

- [ ] Create `packages/dashboard/app/hooks/useProjectRuntime.ts`:
  ```typescript
  import { useState, useEffect, useCallback } from "react";
  import type { RuntimeStatus } from "@fusion/core";
  import { fetchProjectStatus } from "../api";
  
  export interface UseProjectRuntimeResult {
    status: RuntimeStatus | null;
    loading: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
  }
  
  export function useProjectRuntime(projectId: string | null): UseProjectRuntimeResult {
    const [status, setStatus] = useState<RuntimeStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    
    const refresh = useCallback(async () => {
      if (!projectId) return;
      try {
        setLoading(true);
        const data = await fetchProjectStatus(projectId);
        setStatus(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    }, [projectId]);
    
    useEffect(() => {
      refresh();
      // Poll every 30 seconds
      const interval = setInterval(refresh, 30000);
      return () => clearInterval(interval);
    }, [refresh]);
    
    return { status, loading, error, refresh };
  }
  ```

- [ ] Update `packages/dashboard/app/hooks/useTasks.ts`:
  - Add optional `projectId` parameter to hook
  - Pass `projectId` to `fetchTasks` calls

**Artifacts:**
- `packages/dashboard/app/hooks/useProjects.ts` (new)
- `packages/dashboard/app/hooks/useProjectRuntime.ts` (new)
- `packages/dashboard/app/hooks/useTasks.ts` (modified — projectId support)

### Step 4: Projects Overview Page

Create the main multi-project dashboard view.

- [ ] Create `packages/dashboard/app/components/ProjectCard.tsx`:
  ```typescript
  import type { Project } from "@fusion/core";
  import { Folder, Play, Pause, AlertCircle, CheckCircle } from "lucide-react";
  import { useProjectRuntime } from "../hooks/useProjectRuntime";
  
  interface ProjectCardProps {
    project: Project;
    onClick: () => void;
    taskCount?: { todo: number; inProgress: number; done: number };
  }
  
  export function ProjectCard({ project, onClick, taskCount }: ProjectCardProps) {
    const { status } = useProjectRuntime(project.id);
    
    const statusIcon = {
      active: <CheckCircle className="icon-success" />,
      paused: <Pause className="icon-warning" />,
      errored: <AlertCircle className="icon-error" />,
      disabled: <AlertCircle className="icon-muted" />,
    }[project.status];
    
    return (
      <div className="project-card" onClick={onClick} role="button" tabIndex={0}>
        <div className="project-card-header">
          <Folder className="project-icon" />
          <h3>{project.name}</h3>
          {statusIcon}
        </div>
        <p className="project-path">{project.path}</p>
        <div className="project-meta">
          <span className="isolation-badge">{project.isolationMode}</span>
          {project.enabled ? <span className="enabled-badge">Enabled</span> : <span className="disabled-badge">Disabled</span>}
        </div>
        {taskCount && (
          <div className="task-counts">
            <span title="To Do">{taskCount.todo} todo</span>
            <span title="In Progress">{taskCount.inProgress} in progress</span>
            <span title="Done">{taskCount.done} done</span>
          </div>
        )}
        {status && (
          <div className="runtime-status">
            <span className={`state-${status.state}`}>{status.state}</span>
            {status.activeTasks > 0 && <span>{status.activeTasks} active</span>}
            {status.queuedTasks > 0 && <span>{status.queuedTasks} queued</span>}
          </div>
        )}
      </div>
    );
  }
  ```

- [ ] Create `packages/dashboard/app/components/ProjectsOverview.tsx`:
  ```typescript
  import { useState } from "react";
  import { Plus, Grid, List } from "lucide-react";
  import { useProjects } from "../hooks/useProjects";
  import { ProjectCard } from "./ProjectCard";
  import type { Project } from "@fusion/core";
  
  interface ProjectsOverviewProps {
    onProjectClick: (project: Project) => void;
    onCreateClick: () => void;
  }
  
  export function ProjectsOverview({ onProjectClick, onCreateClick }: ProjectsOverviewProps) {
    const { projects, loading, error, deleteProject } = useProjects();
    const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
    
    if (loading) return <div className="projects-loading">Loading projects...</div>;
    if (error) return <div className="projects-error">Error: {error.message}</div>;
    
    return (
      <div className="projects-overview">
        <div className="projects-header">
          <h1>Projects</h1>
          <div className="view-toggle">
            <button 
              className={viewMode === "grid" ? "active" : ""} 
              onClick={() => setViewMode("grid")}
              title="Grid view"
            >
              <Grid size={18} />
            </button>
            <button 
              className={viewMode === "list" ? "active" : ""} 
              onClick={() => setViewMode("list")}
              title="List view"
            >
              <List size={18} />
            </button>
          </div>
          <button className="btn-primary" onClick={onCreateClick}>
            <Plus size={18} />
            Add Project
          </button>
        </div>
        
        {projects.length === 0 ? (
          <div className="projects-empty">
            <p>No projects registered yet.</p>
            <button className="btn-primary" onClick={onCreateClick}>
              Add your first project
            </button>
          </div>
        ) : (
          <div className={`projects-${viewMode}`}>
            {projects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                onClick={() => onProjectClick(project)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  ```

- [ ] Add CSS to `packages/dashboard/app/styles.css`:
  ```css
  .projects-overview { padding: 1rem; }
  .projects-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .projects-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
  .projects-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .project-card { border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; cursor: pointer; transition: box-shadow 0.2s; }
  .project-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .project-card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .project-path { font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.5rem; }
  .project-meta { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
  .isolation-badge, .enabled-badge, .disabled-badge { font-size: 0.75rem; padding: 0.125rem 0.375rem; border-radius: 4px; }
  ```

- [ ] Write tests in `packages/dashboard/app/components/ProjectsOverview.test.tsx`:
  - Renders loading state
  - Renders empty state with CTA
  - Renders grid of project cards
  - Calls onProjectClick when card clicked
  - Calls onCreateClick when add button clicked
  - Toggles between grid and list views

**Artifacts:**
- `packages/dashboard/app/components/ProjectCard.tsx` (new)
- `packages/dashboard/app/components/ProjectsOverview.tsx` (new)
- `packages/dashboard/app/components/ProjectsOverview.test.tsx` (new)
- `packages/dashboard/app/styles.css` (modified — project styles)

### Step 5: Project Setup Wizard

Create the multi-step flow for registering new projects.

- [ ] Create `packages/dashboard/app/components/ProjectSetupWizard.tsx`:
  ```typescript
  import { useState, useCallback } from "react";
  import { Folder, Check, AlertCircle, ChevronRight, ChevronLeft } from "lucide-react";
  import type { ProjectCreateInput, ProjectIsolationMode } from "@fusion/core";
  
  interface ProjectSetupWizardProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (input: ProjectCreateInput) => Promise<void>;
  }
  
  type WizardStep = "path" | "config" | "confirm";
  
  export function ProjectSetupWizard({ isOpen, onClose, onCreate }: ProjectSetupWizardProps) {
    const [step, setStep] = useState<WizardStep>("path");
    const [projectPath, setProjectPath] = useState("");
    const [projectName, setProjectName] = useState("");
    const [isolationMode, setIsolationMode] = useState<ProjectIsolationMode>("in-process");
    const [validating, setValidating] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    
    const validatePath = useCallback(async (path: string) => {
      setValidating(true);
      setValidationError(null);
      try {
        // API call to validate path exists and is not already registered
        const res = await fetch("/api/projects/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!res.ok) {
          const { error } = await res.json();
          setValidationError(error || "Invalid path");
          return false;
        }
        // Auto-extract project name from directory
        const name = path.split("/").pop() || path.split("\\").pop() || "New Project";
        setProjectName(name);
        return true;
      } catch {
        setValidationError("Failed to validate path");
        return false;
      } finally {
        setValidating(false);
      }
    }, []);
    
    const handleNext = async () => {
      if (step === "path") {
        const valid = await validatePath(projectPath);
        if (valid) setStep("config");
      } else if (step === "config") {
        setStep("confirm");
      } else if (step === "confirm") {
        setCreating(true);
        try {
          await onCreate({
            name: projectName,
            path: projectPath,
            isolationMode,
            enabled: true,
          });
          // Reset and close
          setStep("path");
          setProjectPath("");
          setProjectName("");
          setIsolationMode("in-process");
          onClose();
        } catch (err) {
          setValidationError(err instanceof Error ? err.message : "Failed to create project");
        } finally {
          setCreating(false);
        }
      }
    };
    
    const handleBack = () => {
      if (step === "config") setStep("path");
      else if (step === "confirm") setStep("config");
    };
    
    if (!isOpen) return null;
    
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal wizard-modal" onClick={e => e.stopPropagation()}>
          <div className="wizard-header">
            <h2>Add New Project</h2>
            <div className="wizard-steps">
              <span className={step === "path" ? "active" : ""}>1. Path</span>
              <ChevronRight size={16} />
              <span className={step === "config" ? "active" : ""}>2. Configure</span>
              <ChevronRight size={16} />
              <span className={step === "confirm" ? "active" : ""}>3. Confirm</span>
            </div>
          </div>
          
          <div className="wizard-content">
            {step === "path" && (
              <div className="wizard-step">
                <label>Project Path</label>
                <div className="path-input-group">
                  <Folder size={18} />
                  <input
                    type="text"
                    value={projectPath}
                    onChange={e => setProjectPath(e.target.value)}
                    placeholder="/path/to/your/project"
                    disabled={validating}
                  />
                </div>
                {validationError && (
                  <div className="validation-error">
                    <AlertCircle size={16} />
                    {validationError}
                  </div>
                )}
                <p className="help-text">Enter the absolute path to your project directory. The directory must contain a .git folder or you must initialize kb separately.</p>
              </div>
            )}
            
            {step === "config" && (
              <div className="wizard-step">
                <label>Project Name</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                  placeholder="My Project"
                />
                
                <label>Isolation Mode</label>
                <div className="isolation-options">
                  <label className={isolationMode === "in-process" ? "selected" : ""}>
                    <input
                      type="radio"
                      name="isolation"
                      value="in-process"
                      checked={isolationMode === "in-process"}
                      onChange={e => setIsolationMode(e.target.value as ProjectIsolationMode)}
                    />
                    <div>
                      <strong>In-Process</strong>
                      <span>Tasks run in the same Node.js process. Lower overhead, shared memory.</span>
                    </div>
                  </label>
                  <label className={isolationMode === "child-process" ? "selected" : ""}>
                    <input
                      type="radio"
                      name="isolation"
                      value="child-process"
                      checked={isolationMode === "child-process"}
                      onChange={e => setIsolationMode(e.target.value as ProjectIsolationMode)}
                    />
                    <div>
                      <strong>Child Process</strong>
                      <span>Tasks run in isolated subprocesses. Higher overhead, better isolation.</span>
                    </div>
                  </label>
                </div>
              </div>
            )}
            
            {step === "confirm" && (
              <div className="wizard-step">
                <h3>Review</h3>
                <dl className="review-list">
                  <dt>Name</dt>
                  <dd>{projectName}</dd>
                  <dt>Path</dt>
                  <dd>{projectPath}</dd>
                  <dt>Isolation</dt>
                  <dd>{isolationMode}</dd>
                </dl>
                {validationError && (
                  <div className="validation-error">
                    <AlertCircle size={16} />
                    {validationError}
                  </div>
                )}
              </div>
            )}
          </div>
          
          <div className="wizard-actions">
            {step !== "path" && (
              <button className="btn-secondary" onClick={handleBack} disabled={creating}>
                <ChevronLeft size={18} />
                Back
              </button>
            )}
            <button className="btn-primary" onClick={handleNext} disabled={validating || creating}>
              {creating ? "Creating..." : step === "confirm" ? "Create Project" : "Next"}
              {!creating && step !== "confirm" && <ChevronRight size={18} />}
              {!creating && step === "confirm" && <Check size={18} />}
            </button>
          </div>
        </div>
      </div>
    );
  }
  ```

- [ ] Add server-side path validation endpoint to `packages/dashboard/src/project-routes.ts`:
  ```typescript
  // POST /api/projects/validate — Validate path before creation
  router.post("/projects/validate", async (req, res, next) => {
    try {
      const { path } = req.body;
      // Check path exists
      const exists = await stat(path).then(() => true).catch(() => false);
      if (!exists) return res.status(400).json({ error: "Path does not exist" });
      // Check not already registered
      const existing = await store.getProjectByPath?.(path);
      if (existing) return res.status(400).json({ error: "Path already registered" });
      res.json({ valid: true });
    } catch (err) { next(err); }
  });
  ```

- [ ] Write tests in `packages/dashboard/app/components/ProjectSetupWizard.test.tsx`:
  - Renders path input step initially
  - Validates path before proceeding
  - Shows config step with name/isolation inputs
  - Shows review step with summary
  - Calls onCreate with correct input on confirm
  - Resets state when closed

**Artifacts:**
- `packages/dashboard/app/components/ProjectSetupWizard.tsx` (new)
- `packages/dashboard/app/components/ProjectSetupWizard.test.tsx` (new)
- `packages/dashboard/src/project-routes.ts` (modified — add validate endpoint)

### Step 6: Project Drill-Down Navigation

Implement routing and project-specific views.

- [ ] Create `packages/dashboard/app/components/ProjectBreadcrumb.tsx`:
  ```typescript
  import { ChevronRight, Home, Folder } from "lucide-react";
  import { Link } from "react-router-dom";
  import type { Project } from "@fusion/core";
  
  interface ProjectBreadcrumbProps {
    project?: Project;
    currentView?: "board" | "list" | "settings";
  }
  
  export function ProjectBreadcrumb({ project, currentView }: ProjectBreadcrumbProps) {
    return (
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link to="/">
              <Home size={16} />
              Projects
            </Link>
          </li>
          {project && (
            <>
              <ChevronRight size={16} />
              <li>
                <Link to={`/projects/${project.id}`}>
                  <Folder size={16} />
                  {project.name}
                </Link>
              </li>
            </>
          )}
          {currentView && (
            <>
              <ChevronRight size={16} />
              <li aria-current="page">{currentView}</li>
            </>
          )}
        </ol>
      </nav>
    );
  }
  ```

- [ ] Create `packages/dashboard/app/components/ProjectDetail.tsx`:
  ```typescript
  import { useParams, useNavigate } from "react-router-dom";
  import { ArrowLeft, Settings } from "lucide-react";
  import { useProjects } from "../hooks/useProjects";
  import { useTasks } from "../hooks/useTasks";
  import { ProjectBreadcrumb } from "./ProjectBreadcrumb";
  import { Board } from "./Board";
  import { ListView } from "./ListView";
  import { Header } from "./Header";
  
  export function ProjectDetail() {
    const { projectId } = useParams<{ projectId: string }>();
    const navigate = useNavigate();
    const { projects } = useProjects();
    const { tasks, createTask, moveTask } = useTasks(projectId); // project-scoped
    const [view, setView] = useState<"board" | "list">("board");
    
    const project = projects.find(p => p.id === projectId);
    
    if (!project) return <div>Project not found</div>;
    
    return (
      <div className="project-detail">
        <ProjectBreadcrumb project={project} currentView={view} />
        
        <div className="project-detail-header">
          <h1>{project.name}</h1>
          <div className="project-actions">
            <button onClick={() => navigate("/")}>
              <ArrowLeft size={18} />
              Back to Projects
            </button>
            <button onClick={() => navigate(`/projects/${projectId}/settings`)}>
              <Settings size={18} />
              Project Settings
            </button>
          </div>
        </div>
        
        <div className="view-toggle">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>
            Board
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
            List
          </button>
        </div>
        
        {view === "board" ? (
          <Board
            tasks={tasks}
            projectId={projectId}
            onMoveTask={moveTask}
            onQuickCreate={(input) => createTask({ ...input, projectId })}
          />
        ) : (
          <ListView
            tasks={tasks}
            projectId={projectId}
            onMoveTask={moveTask}
            onQuickCreate={(input) => createTask({ ...input, projectId })}
          />
        )}
      </div>
    );
  }
  ```

- [ ] Create `packages/dashboard/app/routes.tsx` (React Router configuration):
  ```typescript
  import { Routes, Route, Navigate } from "react-router-dom";
  import { ProjectsOverview } from "./components/ProjectsOverview";
  import { ProjectDetail } from "./components/ProjectDetail";
  import { ProjectSettings } from "./components/ProjectSettings";
  import type { Project } from "@fusion/core";
  
  interface AppRoutesProps {
    onProjectClick: (project: Project) => void;
    onCreateProject: () => void;
  }
  
  export function AppRoutes({ onProjectClick, onCreateProject }: AppRoutesProps) {
    return (
      <Routes>
        <Route 
          path="/" 
          element={
            <ProjectsOverview 
              onProjectClick={onProjectClick} 
              onCreateClick={onCreateProject}
            />
          } 
        />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/projects/:projectId/settings" element={<ProjectSettings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }
  ```

- [ ] Modify `packages/dashboard/app/App.tsx`:
  - Wrap with `BrowserRouter` from react-router-dom
  - Replace the conditional Board/ListView with `<AppRoutes />`
  - Move modal state management (NewTaskModal, etc.) to work within routed views
  - Add navigation handler for project clicks: `navigate(`/projects/${project.id}`)`

- [ ] Modify `packages/dashboard/app/components/Header.tsx`:
  - Add project context awareness (show project name when in project view)
  - Add back button when in project view
  - Update search to be project-scoped when applicable

**Artifacts:**
- `packages/dashboard/app/components/ProjectBreadcrumb.tsx` (new)
- `packages/dashboard/app/components/ProjectDetail.tsx` (new)
- `packages/dashboard/app/routes.tsx` (new)
- `packages/dashboard/app/App.tsx` (modified — router integration)
- `packages/dashboard/app/components/Header.tsx` (modified — project context)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run new component tests:
  ```bash
  pnpm --filter @fusion/dashboard test -- ProjectsOverview.test.tsx
  pnpm --filter @fusion/dashboard test -- ProjectSetupWizard.test.tsx
  pnpm --filter @fusion/dashboard test -- project-routes.test.ts
  ```
- [ ] Run all dashboard tests:
  ```bash
  pnpm --filter @fusion/dashboard test
  ```
- [ ] Run full test suite:
  ```bash
  pnpm test
  ```
- [ ] Verify build:
  ```bash
  pnpm build
  ```
- [ ] Manual verification checklist:
  - [ ] Navigate to `/` — see Projects Overview (or empty state with CTA)
  - [ ] Click "Add Project" — wizard opens with path step
  - [ ] Enter invalid path — validation error shown
  - [ ] Enter valid path — proceed to config step
  - [ ] Change isolation mode — selection updates
  - [ ] Complete wizard — project appears in overview
  - [ ] Click project card — navigate to project detail
  - [ ] See project-specific tasks in board view
  - [ ] Switch to list view — see project-scoped tasks
  - [ ] Use breadcrumb to navigate back to projects
  - [ ] Delete project from overview — confirmation, then removed

**Artifacts:**
- All tests passing
- Build clean
- Manual verification complete

### Step 8: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` with Multi-Project section:
  ```markdown
  ## Multi-Project Dashboard

  The dashboard supports managing multiple kb projects from a unified interface.

  ### Projects Overview

  The root route (`/`) displays all registered projects with at-a-glance status:
  - Project name and path
  - Isolation mode (in-process/child-process)
  - Runtime status (active, paused, errored, disabled)
  - Task counts by column

  ### Adding Projects

  Click "Add Project" to open the setup wizard:
  1. **Path**: Enter the absolute path to the project directory
  2. **Configure**: Set display name and isolation mode
  3. **Confirm**: Review and create

  ### Project Navigation

  Click any project card to enter the project context. The URL becomes `/projects/:projectId`.
  Within a project, you see the familiar board/list views but scoped to that project's tasks.

  ### API Routes

  - `GET /api/projects` — List all projects
  - `POST /api/projects` — Register new project
  - `GET /api/projects/:id` — Get project details
  - `PATCH /api/projects/:id` — Update project
  - `DELETE /api/projects/:id` — Unregister project
  - `GET /api/projects/:id/status` — Get runtime status
  ```

- [ ] Create changeset:
  ```bash
  cat > .changeset/dashboard-multi-project-ux.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add multi-project dashboard UX with Projects Overview page, project drill-down navigation, and Project Setup Wizard. Dashboard now supports managing multiple kb projects with route-based navigation and project-scoped task views.
  EOF
  ```

- [ ] Update `AGENTS.md` with dashboard multi-project patterns if needed

**Artifacts:**
- `packages/dashboard/README.md` (modified — multi-project docs)
- `.changeset/dashboard-multi-project-ux.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add "Multi-Project Dashboard" section
- `packages/dashboard/app/api.ts` — Project API methods documented via types
- `packages/dashboard/src/project-routes.ts` — API endpoints with JSDoc comments

**Check If Affected:**
- `AGENTS.md` — May need reference to multi-project dashboard patterns
- `packages/core/README.md` — Cross-reference CentralCoreStore for project management

## Completion Criteria

- [ ] All steps complete (0-8)
- [ ] All tests passing (new + existing)
- [ ] Build passes with no TypeScript errors
- [ ] Dashboard features:
  - Projects Overview page displays all projects with status
  - Project Setup Wizard validates paths and creates projects
  - Clicking project navigates to project detail view
  - Project detail shows project-scoped tasks in board/list views
  - Breadcrumb navigation works correctly
- [ ] API features:
  - `GET /api/projects` returns all projects
  - `POST /api/projects` creates new project with validation
  - `GET /api/projects/:id/status` returns runtime status
  - Tasks API supports `projectId` parameter
- [ ] React hooks:
  - `useProjects()` provides project CRUD operations
  - `useProjectRuntime()` provides runtime status polling
  - `useTasks(projectId)` fetches project-scoped tasks
- [ ] Documentation updated with multi-project usage
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-003): complete Step N — description`
- **Bug fixes:** `fix(KB-003): description`
- **Tests:** `test(KB-003): description`
- **Docs:** `docs(KB-003): description`

Example commits:
```
feat(KB-003): complete Step 1 — add project API routes
feat(KB-003): complete Step 2 — add client API methods
feat(KB-003): complete Step 3 — add useProjects and useProjectRuntime hooks
feat(KB-003): complete Step 4 — implement Projects Overview page
feat(KB-003): complete Step 5 — implement Project Setup Wizard
feat(KB-003): complete Step 6 — add drill-down navigation with React Router
docs(KB-003): document multi-project dashboard features
```

## Do NOT

- **Do NOT** break existing single-project behavior — the dashboard should still work when only one project exists
- **Do NOT** modify the core TaskStore schema — project attribution stays in the central database
- **Do NOT** implement project-level settings UI — that's a future enhancement
- **Do NOT** add real-time project status updates via WebSocket — polling is sufficient for now
- **Do NOT** skip path validation in the wizard — always verify paths exist before registration
- **Do NOT** use synchronous filesystem operations — follow existing async patterns
- **Do NOT** commit without running the full test suite
- **Do NOT** duplicate Project types — import from `@fusion/core`
