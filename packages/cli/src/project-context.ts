/**
 * Project context resolution utilities for multi-project CLI operations.
 *
 * Provides project detection, resolution, and TaskStore management
 * for operating on tasks across multiple registered projects.
 */

import { TaskStore, createTaskStoreForBackend, type AsyncDataLayer, type RegisteredProject, CentralCore, GlobalSettingsStore, isValidSqliteDatabaseFile } from "@fusion/core";
import { resolve, dirname, basename } from "node:path";

/** Project context for CLI operations */
export interface ProjectContext {
  /** Project ID */
  projectId: string;
  /** Absolute path to project directory */
  projectPath: string;
  /** Project name */
  projectName: string;
  /** Whether the project is registered in the central registry */
  isRegistered: boolean;
  /** TaskStore instance for this project */
  store: TaskStore;
}

/** Cache of TaskStore instances by project ID to avoid re-initialization */
const storeCache = new Map<string, TaskStore>();

/**
 * Resolve a project from explicit name flag, default project, or CWD detection.
 *
 * Resolution order:
 * 1. If `projectNameFlag` provided: look up by name (case-insensitive) or ID (exact)
 * 2. Else if default project set in global settings: use that project
 * 3. Else: auto-detect from CWD by finding nearest `.fusion/fusion.db`
 *
 * @param projectNameFlag - Optional explicit project name/ID from --project flag
 * @param cwd - Current working directory for CWD detection (default: process.cwd())
 * @returns ProjectContext with resolved project and initialized TaskStore
 * @throws Error if project not found or no project detected from CWD
 */
export async function resolveProject(
  projectNameFlag?: string,
  cwd: string = process.cwd(),
  globalDir?: string,
): Promise<ProjectContext> {
  const central = new CentralCore(globalDir);
  await central.init();

  try {
    let project: RegisteredProject | undefined;

    // 1. Explicit --project flag
    if (projectNameFlag) {
      project = await findProjectByNameOrId(central, projectNameFlag);
      if (!project) {
        throw new Error(
          `Project '${projectNameFlag}' not found. Run 'fusion project list' to see registered projects.`
        );
      }
    }

    // 2. Default project from global settings
    if (!project) {
      const defaultProject = await getDefaultProject(globalDir);
      if (defaultProject) {
        project = await central.getProject(defaultProject.id);
        // If default project was deleted from registry, clear it
        if (!project) {
          await clearDefaultProject(globalDir);
        }
      }
    }

    // 3. Auto-detect from CWD
    if (!project) {
      const detected = await detectProjectFromCwd(cwd, central);
      if (!detected) {
        throw new Error(
          `No fusion project found in current directory. Use --project or run from a project directory.`
        );
      }

      const isRegistered = Boolean(detected.id);
      const store = isRegistered
        ? await getStoreForProject(detected.id, detected.path, globalDir)
        : await createLocalStore(detected.path, globalDir);

      // For unregistered projects, use the path as the project ID
      const projectId = isRegistered ? detected.id : detected.path;

      return {
        projectId,
        projectPath: detected.path,
        projectName: detected.name,
        isRegistered,
        store,
      };
    }

    const store = await getStoreForProject(project.id, project.path, globalDir);

    return {
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      isRegistered: true,
      store,
    };
  } finally {
    await central.close();
  }
}

/**
 * Get the default project from global settings.
 * Returns undefined if no default is set or if the project no longer exists.
 */
export async function getDefaultProject(globalDir?: string): Promise<RegisteredProject | undefined> {
  const globalStore = new GlobalSettingsStore(globalDir);
  await globalStore.init();

  const settings = await globalStore.getSettings();
  if (!settings.defaultProjectId) {
    return undefined;
  }

  const central = new CentralCore(globalDir);
  await central.init();
  try {
    return await central.getProject(settings.defaultProjectId);
  } finally {
    await central.close();
  }
}

/**
 * Set the default project in global settings.
 * @param projectId - Project ID to set as default
 * @throws Error if project not found
 */
export async function setDefaultProject(projectId: string, globalDir?: string): Promise<void> {
  // Verify project exists
  const central = new CentralCore(globalDir);
  await central.init();
  try {
    const project = await central.getProject(projectId);
    if (!project) {
      throw new Error(`Project '${projectId}' not found.`);
    }
  } finally {
    await central.close();
  }

  const globalStore = new GlobalSettingsStore(globalDir);
  await globalStore.init();
  await globalStore.updateSettings({ defaultProjectId: projectId });
}

/**
 * Clear the default project setting.
 */
export async function clearDefaultProject(globalDir?: string): Promise<void> {
  const globalStore = new GlobalSettingsStore(globalDir);
  await globalStore.init();
  const current = await globalStore.getSettings();
   
  const { defaultProjectId: _, ...rest } = current;
  await globalStore.updateSettings(rest as Record<string, unknown>);
}

/**
 * Detect a project from the current working directory by walking up
 * the directory tree looking for `.fusion/fusion.db`.
 *
 * @param cwd - Starting directory (typically process.cwd())
 * @param central - Initialized CentralCore instance
 * @returns Registered project if found, undefined otherwise
 */
export async function detectProjectFromCwd(
  cwd: string,
  central: CentralCore
): Promise<RegisteredProject | { id: string; name: string; path: string } | undefined> {
  const startDir = resolve(cwd);
  let currentDir = startDir;

  // Walk up the directory tree
  while (true) {
    // Check for fn database
    const kbPath = resolve(currentDir, ".fusion", "fusion.db");
    if (isValidSqliteDatabaseFile(kbPath)) {
      // Found a fn project - check if it's registered
      const project = await central.getProjectByPath(currentDir);
      if (project) {
        return project;
      }

      // For unregistered projects, only accept an exact CWD match.
      // This preserves legacy single-project behavior without accidentally
      // resolving unrelated parent directories higher in the filesystem.
      if (currentDir === startDir) {
        return {
          id: "",
          name: basename(currentDir) || "current-project",
          path: currentDir,
        };
      }
    }

    // Move up to parent
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached root, stop
      break;
    }
    currentDir = parentDir;
  }

  return undefined;
}

/**
 * Find a project by name (case-insensitive) or ID (exact match).
 */
async function findProjectByNameOrId(
  central: CentralCore,
  nameOrId: string
): Promise<RegisteredProject | undefined> {
  // First try exact ID match
  const byId = await central.getProject(nameOrId);
  if (byId) {
    return byId;
  }

  // Then try case-insensitive name match
  const allProjects = await central.listProjects();
  const lowerName = nameOrId.toLowerCase();
  return allProjects.find((p) => p.name.toLowerCase() === lowerName);
}

/**
 * Get or create a TaskStore for a project.
 * Stores are cached by project ID to avoid re-initialization.
 *
 * @param projectId - Project ID for cache key
 * @param projectPath - Absolute path to project directory
 * @returns Initialized TaskStore
 */
export async function getStoreForProject(
  projectId: string,
  projectPath: string,
  globalSettingsDir?: string,
): Promise<TaskStore> {
  // Check cache first
  const cached = storeCache.get(projectId);
  if (cached) {
    return cached;
  }

  // FNXC:PostgresCutover 2026-07-04: delegate construction to createLocalStore,
  // which boots the PostgreSQL backend via createTaskStoreForBackend (embedded
  // by default, external via DATABASE_URL) instead of a legacy SQLite TaskStore
  // whose runtime was removed under VAL-REMOVAL-005. Caching the resulting store
  // keeps a single connection pool per project for the CLI process lifetime.
  const store = await createLocalStore(projectPath, globalSettingsDir);

  // Cache it
  storeCache.set(projectId, store);
  return store;
}

/**
 * Clear the store cache. Useful for testing or memory management.
 */
export function clearStoreCache(): void {
  storeCache.clear();
}

export async function createLocalStore(
  projectPath: string,
  globalSettingsDir?: string,
): Promise<TaskStore> {
  // FNXC:PostgresCutover 2026-07-04: route through createTaskStoreForBackend so
  // standalone CLI commands (and resolveProject().store) boot PostgreSQL instead
  // of the removed SQLite runtime. The factory returns null only on the
  // FUSION_NO_EMBEDDED_PG=1 opt-out; in that case fall back to the legacy
  // TaskStore, which still needs an explicit init().
  // FNXC:PostgresCutover 2026-07-05-12:00: exported so CLI command
  // catch-fallbacks (task/pr/backup/memory-backup/branch-group/mcp) boot their
  // cwd-rooted store through the same factory instead of constructing a legacy
  // SQLite TaskStore directly (its runtime throws in backend mode).
  const boot = await createTaskStoreForBackend({ rootDir: projectPath, globalSettingsDir });
  if (boot) {
    return boot.taskStore;
  }
  const store = new TaskStore(projectPath, globalSettingsDir);
  await store.init();
  return store;
}

/**
 * Format a project for display in CLI output.
 *
 * @param project - Registered project
 * @param isDefault - Whether this is the default project
 * @returns Formatted string like "* my-app  /path/to/project  [active]"
 */
export function formatProjectLine(project: RegisteredProject, isDefault: boolean): string {
  const marker = isDefault ? "* " : "  ";
  const status = project.status;
  const name = project.name;
  const path = project.path;
  return `${marker}${name}  ${path}  [${status}]`;
}

/**
 * Get a TaskStore for a project specified by name or the current directory.
 * This is a convenience function for commands that need a store.
 *
 * @param projectName - Optional project name/ID from --project flag
 * @param cwd - Current working directory
 * @returns Initialized TaskStore
 */
export async function getStore(
  projectName?: string,
  cwd: string = process.cwd(),
  globalDir?: string,
): Promise<TaskStore> {
  const context = await resolveProject(projectName, cwd, globalDir);
  return context.store;
}

/**
 * Resolve the AgentStore rootDir + backend AsyncDataLayer for agent CLI commands.
 *
 * FNXC:PostgresCutover 2026-07-04: agent commands (stop/start, export, import)
 * must construct AgentStore in backend mode so agent data lives in PostgreSQL,
 * not the removed SQLite runtime (VAL-REMOVAL-005). The asyncLayer is borrowed
 * from the resolved project's TaskStore (same connection pool), mirroring the
 * extension.ts getAgentStore injection. When no project resolves (unregistered
 * cwd) the layer is null and AgentStore falls back to its layerless path.
 */
export async function resolveAgentStoreBase(
  projectName?: string,
): Promise<{ rootDir: string; asyncLayer: AsyncDataLayer | null }> {
  try {
    const context = await resolveProject(projectName);
    return { rootDir: context.projectPath, asyncLayer: context.store.getAsyncLayer() };
  } catch {
    return { rootDir: process.cwd(), asyncLayer: null };
  }
}
