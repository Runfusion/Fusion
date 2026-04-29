import * as fsPromises from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ensureMemoryFileWithBackend, isValidSqliteDatabaseFile } from "@fusion/core";
import type { CentralCore as CentralCoreApi } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { execFileAsync } from "../exec-file.js";
import { getOrCreateProjectStore } from "../project-store-resolver.js";
import type { ApiRouteRegistrar } from "./types.js";

const {
  access,
  stat,
  mkdir,
  readdir,
  rm,
} = fsPromises;

export const registerProjectRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, runtimeLogger, prioritizeProjectsForCurrentDirectory, rethrowAsApiError } = ctx;

  async function withCentralCore<T>(
    run: (central: CentralCoreApi) => Promise<T>,
    onError?: (error: unknown) => Promise<T> | T,
  ): Promise<T> {
    const sharedCentral = options?.centralCore;
    const shouldClose = !sharedCentral;
    const central = sharedCentral ?? new (await import("@fusion/core")).CentralCore();

    try {
      if (!sharedCentral || (typeof central.isInitialized === "function" && !central.isInitialized())) {
        await central.init();
      }
      return await run(central);
    } catch (error) {
      if (onError) {
        return await onError(error);
      }
      throw error;
    } finally {
      if (shouldClose) {
        await central.close();
      }
    }
  }

  // ── Project Management Routes (Multi-Project Support) ───────────────────────
  // These routes require CentralCore for the shared project registry.

  /**
   * GET /api/projects
   * List all registered projects with their basic info.
   * Returns: ProjectInfo[]
   */
  router.get("/projects", async (_req, res) => {
    try {
      const projects = await withCentralCore(
        async (central) => {
          // Reconcile stale "initializing" projects before listing so the
          // dashboard never shows permanent loading spinners for legacy records.
          await central.reconcileProjectStatuses();
          return prioritizeProjectsForCurrentDirectory(await central.listProjects());
        },
        (error) => {
          runtimeLogger.child("projects").warn(
            `Failed to list registered projects: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        },
      );

      res.json(projects);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/across-nodes
   * List all registered projects from all nodes (local + remote).
   * Fetches projects from online remote nodes and merges with local projects.
   * Returns: Array of projects with nodeId and _sourceNodeName for remote projects.
   */
  router.get("/projects/across-nodes", async (_req, res) => {
    try {
      const { localProjects, allNodes } = await withCentralCore(
        async (central) => {
          // Reconcile stale "initializing" projects before listing
          await central.reconcileProjectStatuses();

          // Get local projects and registered nodes in parallel
          const [projects, nodes] = await Promise.all([
            central.listProjects(),
            central.listNodes(),
          ]);

          return { localProjects: projects, allNodes: nodes };
        },
        (error) => {
          runtimeLogger.child("projects:across-nodes").warn(
            `Failed to load local project registry: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { localProjects: [], allNodes: [] };
        },
      );

      // Filter to online remote nodes with URLs
      const remoteNodes = allNodes.filter(
        (node) => node.type === "remote" && node.status === "online" && node.url,
      );

      // Short-circuit: zero remote nodes means we behave exactly like /projects.
      // Skip the Promise.allSettled machinery entirely so local-only setups pay
      // no cross-node aggregation overhead.
      if (remoteNodes.length === 0) {
        const prioritizedProjects = prioritizeProjectsForCurrentDirectory(localProjects);
        res.json(prioritizedProjects);
        return;
      }

      // Fetch projects from all remote nodes in parallel
      const remoteProjectArrays = await Promise.allSettled(
        remoteNodes.map(async (node) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          try {
            const response = await fetch(`${node.url}/api/projects`, {
              headers: {
                Authorization: `Bearer ${node.apiKey}`,
              },
              signal: controller.signal,
            });

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const projects = (await response.json()) as Array<{
              id: string;
              name: string;
              path: string;
              status: "active" | "paused" | "errored" | "initializing";
              isolationMode: "in-process" | "child-process";
              nodeId?: string;
              createdAt: string;
              updatedAt: string;
              lastActivityAt?: string;
            }>;

            // Tag each remote project with the source node info
            return projects.map((project) => ({
              ...project,
              nodeId: node.id,
              _sourceNodeName: node.name,
            }));
          } finally {
            clearTimeout(timeoutId);
          }
        }),
      );

      // Collect successful remote projects, log failures
      type RemoteProject = {
        id: string;
        name: string;
        path: string;
        status: "active" | "paused" | "errored" | "initializing";
        isolationMode: "in-process" | "child-process";
        nodeId: string;
        _sourceNodeName: string;
        createdAt: string;
        updatedAt: string;
        lastActivityAt?: string;
      };
      const remoteProjects = remoteProjectArrays
        .filter((result): result is PromiseFulfilledResult<RemoteProject[]> => result.status === "fulfilled")
        .flatMap((result) => result.value);

      // Log failures for any unreachable nodes
      remoteProjectArrays.forEach((result, index) => {
        if (result.status === "rejected") {
          const node = remoteNodes[index];
          runtimeLogger.child("projects:across-nodes").warn(
            `Failed to fetch projects from node ${node?.id}: ${result.reason?.message ?? result.reason}`,
          );
        }
      });

      // Merge local and remote projects
      const mergedProjects = [...localProjects, ...remoteProjects];

      // Apply directory prioritization
      const prioritizedProjects = prioritizeProjectsForCurrentDirectory(mergedProjects);

      res.json(prioritizedProjects);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects
   * Register a new project.
   * Body: {
   *   name: string,
   *   path: string,
   *   isolationMode?: "in-process" | "child-process",
   *   nodeId?: string,
   *   cloneUrl?: string
   * }
   * Returns: RegisteredProject
   */
  router.post("/projects", async (req, res) => {
    try {
      const { name, path, isolationMode = "in-process", nodeId, cloneUrl } = req.body;

      if (!name || typeof name !== "string" || !name.trim()) {
        throw badRequest("name is required and must be a non-empty string");
      }
      if (!path || typeof path !== "string" || !path.trim()) {
        throw badRequest("path is required and must be a non-empty string");
      }
      if (!["in-process", "child-process"].includes(isolationMode)) {
        throw badRequest("isolationMode must be 'in-process' or 'child-process'");
      }

      const normalizedName = name.trim();
      const normalizedPath = path.trim();
      let normalizedCloneUrl: string | undefined;

      if (normalizedPath.includes("\0")) {
        throw badRequest("path cannot contain null bytes");
      }
      if (!isAbsolute(normalizedPath)) {
        throw badRequest("path must be an absolute path");
      }

      if (cloneUrl !== undefined) {
        if (typeof cloneUrl !== "string") {
          throw badRequest("cloneUrl must be a non-empty string when provided");
        }

        const trimmedCloneUrl = cloneUrl.trim();
        if (trimmedCloneUrl.length === 0) {
          throw badRequest("cloneUrl must be a non-empty string when provided");
        }
        if (trimmedCloneUrl.includes("\0")) {
          throw badRequest("cloneUrl cannot contain null bytes");
        }

        normalizedCloneUrl = trimmedCloneUrl;
      }

      const isCloneMode = normalizedCloneUrl !== undefined;
      let destinationCreatedForClone = false;

      if (!isCloneMode) {
        // Existing-directory mode: path must already exist.
        try {
          await access(normalizedPath);
        } catch {
          throw badRequest("Project path does not exist");
        }
      } else {
        // Clone mode: parent directory must exist.
        const destinationParent = dirname(normalizedPath);
        try {
          await access(destinationParent);
        } catch {
          throw badRequest("Clone destination parent directory does not exist");
        }

        // Destination must either not exist yet, or be an empty directory.
        let destinationExists = false;
        try {
          const destinationStats = await stat(normalizedPath);
          destinationExists = true;
          if (!destinationStats.isDirectory()) {
            throw badRequest("Clone destination must be a directory path");
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
            throw err;
          }
        }

        if (destinationExists) {
          const entries = await readdir(normalizedPath);
          if (entries.length > 0) {
            throw badRequest("Clone destination must be empty");
          }
        } else {
          await mkdir(normalizedPath, { recursive: false });
          destinationCreatedForClone = true;
        }

        const cloneSource = normalizedCloneUrl;
        if (!cloneSource) {
          throw badRequest("cloneUrl must be a non-empty string when provided");
        }

        try {
          await execFileAsync("git", ["clone", cloneSource, normalizedPath], {
            timeout: 90_000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: "utf-8",
          });
        } catch (cloneError) {
          if (destinationCreatedForClone) {
            try {
              await rm(normalizedPath, { recursive: true, force: true });
            } catch {
              // Best-effort cleanup only.
            }
          }

          const cloneErrorInfo = cloneError as Error & { stderr?: string; stdout?: string };
          const details = [cloneErrorInfo.stderr, cloneErrorInfo.stdout, cloneErrorInfo.message]
            .find((value) => typeof value === "string" && value.trim().length > 0)
            ?.toString()
            .trim();
          throw badRequest(`Git clone failed${details ? `: ${details}` : ""}`);
        }
      }

      let hasFusionDir = false;
      const fusionDirPath = join(normalizedPath, ".fusion");
      try {
        await access(fusionDirPath);
        hasFusionDir = true;
      } catch {
        hasFusionDir = false;
      }

      const activeProject = await withCentralCore(async (central) => {
        const project = await central.registerProject({
          name: normalizedName,
          path: normalizedPath,
          isolationMode,
          nodeId,
        });

        // Activate the project (registration sets it to 'initializing')
        return await central.updateProject(project.id, { status: "active" });
      });

      // Bootstrap memory files (non-blocking, non-fatal)
      ensureMemoryFileWithBackend(normalizedPath).catch(() => {
        // Memory bootstrap failure is non-fatal - project registration succeeded
      });

      // Notify the host (serve.ts/daemon.ts) so it can run project-setup
      // side-effects like installing the fusion Claude-skill into
      // .claude/skills/fusion when pi-claude-cli is configured. The callback
      // is responsible for catching its own errors — a failure here must not
      // fail the registration response.
      if (options?.onProjectRegistered) {
        try {
          options.onProjectRegistered({
            id: activeProject.id,
            name: activeProject.name,
            path: activeProject.path,
          });
        } catch (hookErr) {
          runtimeLogger.warn(
            `onProjectRegistered callback threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
      }
      res.status(201).json({ ...activeProject, _meta: { hasFusionDir: hasFusionDir ? undefined : false } });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("already registered")
        ? 409
        : (err instanceof Error ? err.message : String(err)).includes("Duplicate path")
          ? 409
          : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * POST /api/projects/detect
   * Auto-detect fn projects in a directory.
   * Body: { basePath?: string }
   * Returns: { projects: DetectedProject[] }
   */
  router.post("/projects/detect", async (req, res) => {
    try {
      const { basePath } = req.body;

      // Default to home directory if no basePath provided
      const searchPath = basePath || process.env.HOME || process.env.USERPROFILE || ".";

      // Check search path exists (async to avoid blocking event loop)
      try {
        await access(searchPath);
      } catch {
        throw badRequest("Base path does not exist");
      }

      // Get list of existing projects to check for duplicates
      const existingProjects = await withCentralCore(
        async (central) => await central.listProjects(),
        (error) => {
          runtimeLogger.child("projects:detect").warn(
            `Failed to load existing projects during detection: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        },
      );

      const existingPaths = new Set(existingProjects.map((p: { path: string }) => p.path));

      // Scan for openable .fusion/fusion.db files (indicating fn projects)
      const detected: Array<{ path: string; suggestedName: string; existing: boolean }> = [];

      try {
        const entries = await readdir(searchPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const dirPath = join(searchPath, entry.name);
          if (isValidSqliteDatabaseFile(join(dirPath, ".fusion", "fusion.db"))) {
            detected.push({
              path: dirPath,
              suggestedName: entry.name,
              existing: existingPaths.has(dirPath),
            });
          }
        }
      } catch {
        // Ignore read errors
      }

      res.json({ projects: detected });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id
   * Get a single project by ID.
   */
  router.get("/projects/:id", async (req, res) => {
    try {
      const project = await withCentralCore(async (central) => await central.getProject(req.params.id));

      if (!project) {
        throw notFound("Project not found");
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/projects/:id
   * Update a project.
   */
  router.patch("/projects/:id", async (req, res) => {
    try {
      const { name, status, isolationMode, nodeId } = req.body;

      const updates: Partial<import("@fusion/core").RegisteredProject> = {};
      if (name !== undefined) updates.name = name;
      if (status !== undefined) updates.status = status as import("@fusion/core").ProjectStatus;
      if (isolationMode !== undefined) updates.isolationMode = isolationMode as "in-process" | "child-process";

      const resultProject = await withCentralCore(async (central) => {
        const project = await central.updateProject(req.params.id, updates);
        if (!project) {
          throw notFound("Project not found");
        }

        if (nodeId === undefined) {
          return project;
        }
        if (nodeId === null) {
          return await central.unassignProjectFromNode(req.params.id);
        }
        if (typeof nodeId === "string" && nodeId.trim()) {
          return await central.assignProjectToNode(req.params.id, nodeId.trim());
        }

        throw badRequest("nodeId must be a non-empty string or null");
      });

      res.json(resultProject);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * DELETE /api/projects/:id
   * Unregister a project.
   */
  router.delete("/projects/:id", async (req, res) => {
    try {
      await withCentralCore(async (central) => {
        await central.unregisterProject(req.params.id);
      });

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * GET /api/projects/:id/health
   * Get health metrics for a specific project.
   * Computes live task counts from the project-scoped task store to ensure
   * accurate stats for all projects, not just the default/first project.
   * Returns: ProjectHealth
   */
  router.get("/projects/:id/health", async (req, res) => {
    try {
      const health = await withCentralCore(async (central) => {
        const project = await central.getProject(req.params.id);
        if (!project) {
          throw notFound("Project not found");
        }

        // Use the project-scoped store resolver to get the correct store for
        // this project. This ensures we compute counts from the right project,
        // regardless of which project is the dashboard's default.
        const projectStore = await getOrCreateProjectStore(req.params.id);

        // Compute live task counts from the project-specific store
        const tasks = await projectStore.listTasks({ slim: true });
        const activeCols = new Set(["triage", "todo", "in-progress", "in-review"]);
        const activeTaskCount = tasks.filter((t) => activeCols.has(t.column)).length;
        const inFlightAgentCount = tasks.filter((t) => t.column === "in-progress").length;
        const totalTasksCompleted = tasks.filter((t) => t.column === "done" || t.column === "archived").length;

        // Get central health metadata (if available) to preserve non-count fields
        const centralHealth = await central.getProjectHealth(req.params.id);

        // Build response: use central health as base if available, otherwise synthesize
        const healthBase = centralHealth ?? {
          projectId: req.params.id,
          status: project.status ?? "active",
          activeTaskCount: 0,
          inFlightAgentCount: 0,
          totalTasksCompleted: 0,
          totalTasksFailed: 0,
          updatedAt: new Date().toISOString(),
        };

        return {
          ...healthBase,
          activeTaskCount,
          inFlightAgentCount,
          totalTasksCompleted,
        };
      });

      res.json(health);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/projects/:id/config
   * Get project-specific configuration.
   * Returns: { maxConcurrent: number, rootDir: string }
   */
  router.get("/projects/:id/config", async (req, res) => {
    try {
      const project = await withCentralCore(async (central) => await central.getProject(req.params.id));

      if (!project) {
        throw notFound("Project not found");
      }

      res.json({
        maxConcurrent: 2,
        rootDir: project.path,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/projects/:id/pause
   * Pause a project.
   */
  router.post("/projects/:id/pause", async (req, res) => {
    try {
      const projectId = req.params.id;

      // Use engineManager if available (production mode)
      if (options?.engineManager) {
        await options.engineManager.pauseProject(projectId);
      } else {
        // Fallback: update CentralCore directly (dev mode)
        await withCentralCore(async (central) => {
          await central.updateProject(projectId, { status: "paused" });
          await central.updateProjectHealth(projectId, { status: "paused" });
        });
      }

      // Fetch and return the updated project
      const project = await withCentralCore(async (central) => await central.getProject(projectId));

      if (!project) {
        throw new ApiError(404, `Project ${projectId} not found`);
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * POST /api/projects/:id/resume
   * Resume a paused project.
   */
  router.post("/projects/:id/resume", async (req, res) => {
    try {
      const projectId = req.params.id;

      // Use engineManager if available (production mode)
      if (options?.engineManager) {
        await options.engineManager.resumeProject(projectId);
      } else {
        // Fallback: update CentralCore directly (dev mode)
        await withCentralCore(async (central) => {
          await central.updateProject(projectId, { status: "active" });
          await central.updateProjectHealth(projectId, { status: "active" });
        });
      }

      // Fetch and return the updated project
      const project = await withCentralCore(async (central) => await central.getProject(projectId));

      if (!project) {
        throw new ApiError(404, `Project ${projectId} not found`);
      }

      res.json(project);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });
};
