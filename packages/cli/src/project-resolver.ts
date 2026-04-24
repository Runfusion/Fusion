/**
 * Project Resolution Module
 *
 * Handles determination of which project to use for CLI commands based on:
 * - Explicit `--project <name>` flag
 * - Current working directory auto-detection (walking up to find `.fusion/`)
 * - Default project when only one is registered
 * - Interactive prompts when ambiguous
 */

import { existsSync, statSync } from "node:fs";
import { dirname, resolve, normalize } from "node:path";
import { createInterface } from "node:readline/promises";
import { CentralCore, type RegisteredProject, type TaskStore } from "@fusion/core";
import { ProjectManager } from "@fusion/engine";

// Singleton instances for reuse across commands
let centralCoreInstance: CentralCore | null = null;
let projectManagerInstance: ProjectManager | null = null;

/**
 * Error thrown when project resolution fails with actionable context.
 */
export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_FOUND"
      | "NOT_REGISTERED"
      | "MULTIPLE_MATCHES"
      | "NO_PROJECTS"
      | "PATH_MISMATCH"
      | "NOT_INITIALIZED"
      | "CANCELLED",
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProjectResolutionError";
  }
}

/**
 * Resolved project with all necessary references for command execution.
 */
export interface ResolvedProject {
  /** Project ID from CentralCore */
  projectId: string;
  /** Project display name */
  name: string;
  /** Absolute path to project directory */
  directory: string;
  /** Project status */
  status: string;
  /** Isolation mode */
  isolationMode: string;
  /** Reference to ProjectRuntime (if started) */
  runtime?: import("@fusion/engine").ProjectRuntime;
  /** Initialized TaskStore for the project */
  store: TaskStore;
}

/**
 * Options for project resolution.
 */
export interface ResolveOptions {
  /** Explicit project name from --project flag */
  project?: string;
  /** Starting directory for cwd-based resolution (defaults to process.cwd()) */
  cwd?: string;
  /** Allow interactive prompts (set to false for non-interactive environments) */
  interactive?: boolean;
}

/**
 * Initialize and return CentralCore singleton.
 * Reuses the same instance across multiple calls for efficiency.
 */
export async function getCentralCore(): Promise<CentralCore> {
  if (!centralCoreInstance) {
    centralCoreInstance = new CentralCore();
    await centralCoreInstance.init();
  }
  return centralCoreInstance;
}

/**
 * Initialize and return ProjectManager singleton.
 * Creates the instance on first call, reuses thereafter.
 */
export async function getProjectManager(): Promise<ProjectManager> {
  if (!projectManagerInstance) {
    const central = await getCentralCore();
    projectManagerInstance = new ProjectManager(central);
  }
  return projectManagerInstance;
}

/**
 * Walk up from the given path to find a `.fusion/` directory.
 *
 * @param startPath - Directory to start searching from
 * @returns Absolute path to the directory containing `.fusion/`, or null if not found
 */
export function findKbDir(startPath: string): string | null {
  let current = resolve(startPath);

  // Safety limit to prevent infinite loops
  for (let i = 0; i < 100; i++) {
    const kbPath = resolve(current, ".fusion");
    if (existsSync(kbPath) && statSync(kbPath).isDirectory()) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached root
      break;
    }
    current = parent;
  }

  return null;
}

/**
 * Prompt the user to select from a list of projects.
 */
async function promptProjectSelection(
  projects: RegisteredProject[],
  message = "Select a project:"
): Promise<RegisteredProject> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n  ${message}`);
  for (let i = 0; i < projects.length; i++) {
    console.log(`    ${i + 1}. ${projects[i].name} (${projects[i].path})`);
  }

  while (true) {
    const answer = await rl.question("\n  Enter number: ");
    const num = parseInt(answer.trim(), 10);

    if (!isNaN(num) && num >= 1 && num <= projects.length) {
      rl.close();
      return projects[num - 1];
    }

    console.log(`    Invalid selection. Please enter a number between 1 and ${projects.length}`);
  }
}

/**
 * Prompt for yes/no confirmation.
 */
async function promptConfirm(message: string, defaultYes = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`  ${message} ${prompt}: `);
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" && defaultYes) return true;
  return trimmed === "y" || trimmed === "yes";
}

/**
 * Resolve which project to use based on options and cwd.
 *
 * Resolution order:
 * 1. If --project <name> flag given, look up by name in registry
 * 2. Walk up from cwd to find .fusion/ directory
 * 3. If found, match path against registered projects
 * 4. If not registered but has .fusion/, prompt to register or error
 * 5. If no .fusion/ found and exactly one project registered, use it
 * 6. If multiple projects and no match, error with list
 *
 * @param options - Resolution options
 * @returns Resolved project with store and runtime references
 * @throws ProjectResolutionError with specific error codes
 */
export async function resolveProject(options: ResolveOptions = {}): Promise<ResolvedProject> {
  const central = await getCentralCore();
  const interactive = options.interactive ?? true;

  // 1. Check explicit --project flag
  if (options.project) {
    const projects = await central.listProjects();
    const match = projects.find((p) => p.name === options.project);

    if (!match) {
      // Suggest similar names if available
      const similar = projects
        .filter((p) => p.name.toLowerCase().includes(options.project!.toLowerCase()))
        .map((p) => p.name);

      let suggestion = "";
      if (similar.length > 0) {
        suggestion = ` Did you mean: ${similar.join(", ")}?`;
      }

      throw new ProjectResolutionError(
        `Project "${options.project}" not found.${suggestion}`,
        "NOT_FOUND",
        { searchedName: options.project, availableProjects: projects.map((p) => p.name) }
      );
    }

    // Check if path still exists
    if (!existsSync(match.path)) {
      throw new ProjectResolutionError(
        `Project "${match.name}" is registered but the directory no longer exists: ${match.path}\n\n` +
          "Run `fn project remove " + match.name + "` to clean up the registry entry.",
        "PATH_MISMATCH",
        { projectId: match.id, path: match.path }
      );
    }

    return createResolvedProject(match);
  }

  // 2. Walk up from cwd to find .fusion/
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const fusionDir = findKbDir(cwd);

  if (fusionDir) {
    // 3. Match path against registered projects
    const allProjects = await central.listProjects();
    const normalizedKbDir = normalize(fusionDir);

    const match = allProjects.find((p) => normalize(p.path) === normalizedKbDir);

    if (match) {
      // Check if path still exists
      if (!existsSync(match.path)) {
        throw new ProjectResolutionError(
          `Project "${match.name}" is registered but the directory no longer exists: ${match.path}\n\n` +
            "Run `fn project remove " + match.name + "` to clean up the registry entry.",
          "PATH_MISMATCH",
          { projectId: match.id, path: match.path }
        );
      }

      return createResolvedProject(match);
    }

    // 4. Has .fusion/ but not registered
    if (interactive) {
      console.log(`\n  Found fn project at ${fusionDir} but it's not registered.`);
      const shouldRegister = await promptConfirm("Register this project now?", true);

      if (shouldRegister) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const defaultName = fusionDir.split("/").pop() || "unnamed";
        const name = await rl.question(`  Project name [${defaultName}]: `);
        rl.close();

        const finalName = name.trim() || defaultName;

        try {
          const newProject = await central.registerProject({
            name: finalName,
            path: fusionDir,
            isolationMode: "in-process",
          });

          // Activate the project (registration sets it to 'initializing')
          await central.updateProject(newProject.id, { status: "active" });

          console.log(`\n  ✓ Registered project "${newProject.name}"`);
          return createResolvedProject(newProject);
        } catch (err: any) {
          throw new ProjectResolutionError(
            `Failed to register project: ${err.message}`,
            "NOT_REGISTERED",
            { directory: fusionDir, error: err.message }
          );
        }
      } else {
        throw new ProjectResolutionError(
          "Project not registered. Run `fn project add <path>` to register.",
          "NOT_REGISTERED",
          { directory: fusionDir }
        );
      }
    } else {
      throw new ProjectResolutionError(
        `Found fn project at ${fusionDir} but it's not registered.\n\n` +
          "Run `fn project add " + fusionDir + "` to register it, or use --project <name>.",
        "NOT_REGISTERED",
        { directory: fusionDir }
      );
    }
  }

  // 5. No .fusion/ found - check registered projects
  const allProjects = await central.listProjects();

  if (allProjects.length === 0) {
    // 6a. No projects at all
    throw new ProjectResolutionError(
      "No projects registered.\n\n" +
        "To get started:\n" +
        "  1. Navigate to your project directory\n" +
        "  2. Run `fn init` to initialize fn\n" +
        "  3. Run `fn project add .` to register it\n" +
        "\nOr: `fn project add <path>` to register from anywhere.",
      "NO_PROJECTS"
    );
  }

  if (allProjects.length === 1) {
    // 6b. Exactly one project - use as default
    const project = allProjects[0];

    // Check if path still exists
    if (!existsSync(project.path)) {
      throw new ProjectResolutionError(
        `The only registered project "${project.name}" has a missing directory: ${project.path}\n\n` +
          "Run `fn project remove " + project.name + "` to clean up, then register a valid project.",
        "PATH_MISMATCH",
        { projectId: project.id, path: project.path }
      );
    }

    return createResolvedProject(project);
  }

  // 6c. Multiple projects - need explicit selection
  if (interactive) {
    const selected = await promptProjectSelection(
      allProjects,
      "Multiple projects registered. Please select one:"
    );
    return createResolvedProject(selected);
  } else {
    const projectList = allProjects.map((p) => `  - ${p.name}: ${p.path}`).join("\n");
    throw new ProjectResolutionError(
      `Multiple projects registered. Use --project <name> to specify one.\n\nAvailable projects:\n${projectList}`,
      "MULTIPLE_MATCHES",
      { availableProjects: allProjects.map((p) => ({ name: p.name, path: p.path })) }
    );
  }
}

/**
 * Create a ResolvedProject from a RegisteredProject.
 * Initializes the TaskStore for the project.
 */
async function createResolvedProject(project: RegisteredProject): Promise<ResolvedProject> {
  // Initialize TaskStore for this project
  const store = new (await import("@fusion/core")).TaskStore(project.path);
  await store.init();

  // Try to get runtime from ProjectManager if available
  let runtime: import("@fusion/engine").ProjectRuntime | undefined;
  try {
    const pm = await getProjectManager();
    runtime = pm.getRuntime(project.id);
  } catch {
    // ProjectManager not initialized or runtime not started - that's ok
    runtime = undefined;
  }

  return {
    projectId: project.id,
    name: project.name,
    directory: project.path,
    status: project.status,
    isolationMode: project.isolationMode,
    runtime,
    store,
  };
}

/**
 * Clean up singleton instances.
 * Call this on CLI exit to close database connections.
 */
export async function cleanupProjectResolution(): Promise<void> {
  if (projectManagerInstance) {
    // ProjectManager doesn't have a close method, but we should stop all runtimes
    try {
      await projectManagerInstance.stopAll();
    } catch {
      // Ignore errors during cleanup
    }
    projectManagerInstance = null;
  }

  if (centralCoreInstance) {
    await centralCoreInstance.close();
    centralCoreInstance = null;
  }
}

/**
 * Get the resolved project without needing to use it immediately.
 * Useful for commands that just need to verify the project exists.
 */
export async function getResolvedProject(options: ResolveOptions = {}): Promise<ResolvedProject> {
  return resolveProject(options);
}

/**
 * Format project resolution error for CLI display.
 */
export function formatResolutionError(error: ProjectResolutionError): string {
  let output = `\n  ✗ ${error.message}\n`;

  if (error.code === "NO_PROJECTS") {
    // Message already includes detailed instructions
  } else if (error.code === "MULTIPLE_MATCHES" && error.context?.availableProjects) {
    // List already included in message
  } else if (error.code === "NOT_FOUND" && error.context?.availableProjects) {
    output += `\n  Available projects:\n`;
    for (const name of error.context.availableProjects as string[]) {
      output += `    - ${name}\n`;
    }
  }

  return output;
}

/**
 * Check if a project is registered at the given path.
 * Returns the project if found, undefined otherwise.
 */
export async function findProjectByPath(
  path: string,
  central?: CentralCore
): Promise<RegisteredProject | undefined> {
  const core = central ?? (await getCentralCore());
  const normalizedPath = normalize(resolve(path));
  const projects = await core.listProjects();

  return projects.find((p) => normalize(p.path) === normalizedPath);
}

/**
 * Check if a project name is already registered.
 */
export async function isProjectNameTaken(
  name: string,
  central?: CentralCore
): Promise<boolean> {
  const core = central ?? (await getCentralCore());
  const projects = await core.listProjects();

  return projects.some((p) => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * Validate that a path contains an initialized fn project (.fusion/ directory exists).
 */
export function isKbProject(path: string): boolean {
  const kbPath = resolve(path, ".fusion");
  return existsSync(kbPath) && statSync(kbPath).isDirectory();
}

/**
 * Get suggested project name from directory path.
 */
export function suggestProjectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "unnamed";
}

/**
 * Resolve absolute path and validate it exists.
 */
export function resolveAbsolutePath(inputPath: string): string {
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new ProjectResolutionError(
      `Path does not exist: ${inputPath}`,
      "NOT_FOUND",
      { path: inputPath }
    );
  }
  if (!statSync(resolved).isDirectory()) {
    throw new ProjectResolutionError(
      `Path is not a directory: ${inputPath}`,
      "NOT_FOUND",
      { path: inputPath }
    );
  }
  return resolved;
}

/**
 * Get a quick summary of all registered projects.
 * Used for CLI hints and error messages.
 */
export async function getProjectSummary(): Promise<
  Array<{ name: string; path: string; status: string }>
> {
  const central = await getCentralCore();
  const projects = await central.listProjects();

  return projects.map((p) => ({
    name: p.name,
    path: p.path,
    status: p.status,
  }));
}

/**
 * Reset the singleton instances. Used primarily for testing.
 */
export function resetProjectResolution(): void {
  centralCoreInstance = null;
  projectManagerInstance = null;
}

/**
 * Check if CentralCore is initialized.
 */
export function isCentralCoreInitialized(): boolean {
  return centralCoreInstance?.isInitialized() ?? false;
}

/**
 * Get all registered projects from CentralCore.
 */
export async function listRegisteredProjects(): Promise<RegisteredProject[]> {
  const central = await getCentralCore();
  return central.listProjects();
}

/**
 * Get a single project by name.
 */
export async function getProjectByName(name: string): Promise<RegisteredProject | undefined> {
  const central = await getCentralCore();
  const projects = await central.listProjects();
  return projects.find((p) => p.name === name);
}

/**
 * Register a new project with interactive prompts for missing info.
 */
export async function registerProjectInteractive(
  dir: string,
  options: {
    name?: string;
    isolation?: "in-process" | "child-process";
    interactive?: boolean;
  } = {}
): Promise<ResolvedProject> {
  const central = await getCentralCore();
  const interactive = options.interactive ?? true;

  // Validate directory
  const absPath = resolveAbsolutePath(dir);

  // Check for .fusion/ directory
  if (!isKbProject(absPath)) {
    if (interactive) {
      console.log(`\n  No .fusion/ directory found in ${absPath}`);
      const shouldInit = await promptConfirm("Initialize fn here first?", true);

      if (shouldInit) {
        // Initialize the project (create .fusion/)
        const { TaskStore } = await import("@fusion/core");
        const store = new TaskStore(absPath);
        await store.init();
        console.log(`  ✓ Initialized fn at ${absPath}`);
      } else {
        throw new ProjectResolutionError(
          "Cannot register project without .fusion/ directory. Run `fn init` first.",
          "NOT_INITIALIZED",
          { directory: absPath }
        );
      }
    } else {
      throw new ProjectResolutionError(
        `No .fusion/ directory found in ${absPath}. Run \`fn init\` first.`,
        "NOT_INITIALIZED",
        { directory: absPath }
      );
    }
  }

  // Determine project name
  let name = options.name;
  if (!name && interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suggested = suggestProjectName(absPath);
    const input = await rl.question(`  Project name [${suggested}]: `);
    rl.close();
    name = input.trim() || suggested;
  }
  name = name || suggestProjectName(absPath);

  // Check for duplicate name
  const isTaken = await isProjectNameTaken(name, central);
  if (isTaken) {
    throw new ProjectResolutionError(
      `A project named "${name}" is already registered. Choose a different name.`,
      "NOT_REGISTERED",
      { name }
    );
  }

  // Register the project
  const project = await central.registerProject({
    name,
    path: absPath,
    isolationMode: options.isolation ?? "in-process",
  });

  // Activate the project (registration sets it to 'initializing')
  await central.updateProject(project.id, { status: "active" });

  return createResolvedProject(project);
}

/**
 * Unregister a project by name.
 */
export async function unregisterProject(
  name: string,
  options: { force?: boolean; interactive?: boolean } = {}
): Promise<void> {
  const central = await getCentralCore();
  const pm = await getProjectManager();
  const interactive = options.interactive ?? true;

  // Find the project
  const project = await getProjectByName(name);
  if (!project) {
    throw new ProjectResolutionError(
      `Project "${name}" not found.`,
      "NOT_FOUND",
      { name }
    );
  }

  // Check if runtime is active
  const runtime = pm.getRuntime(project.id);
  if (runtime) {
    // Stop the runtime first
    await pm.removeProject(project.id);
  }

  // Confirmation prompt
  if (!options.force && interactive) {
    const confirmed = await promptConfirm(
      `Unregister "${project.name}" from the registry? The project data will be preserved.`,
      false
    );
    if (!confirmed) {
      throw new ProjectResolutionError("Cancelled by user.", "CANCELLED");
    }
  }

  // Unregister from CentralCore
  await central.unregisterProject(project.id);
}

/**
 * Get detailed project info including runtime metrics and task counts.
 */
export async function getProjectInfo(name?: string): Promise<{
  project: ResolvedProject;
  health: import("@fusion/core").ProjectHealth | undefined;
  taskCounts: Record<string, number>;
}> {
  const central = await getCentralCore();
  const pm = await getProjectManager();

  let project: ResolvedProject;

  if (name) {
    const registered = await getProjectByName(name);
    if (!registered) {
      throw new ProjectResolutionError(`Project "${name}" not found.`, "NOT_FOUND", { name });
    }
    project = await createResolvedProject(registered);
  } else {
    project = await resolveProject();
  }

  // Get health metrics
  const health = await central.getProjectHealth(project.projectId);

  // Get task counts by column
  const tasks = await project.store.listTasks({ slim: true });
  const taskCounts: Record<string, number> = {};
  for (const task of tasks) {
    taskCounts[task.column] = (taskCounts[task.column] || 0) + 1;
  }

  // Ensure runtime is tracked in ProjectManager
  const runtime = pm.getRuntime(project.projectId);
  if (runtime) {
    project.runtime = runtime;
  }

  return { project, health, taskCounts };
}

/**
 * Start a project runtime if not already running.
 */
export async function startProjectRuntime(projectId: string): Promise<import("@fusion/engine").ProjectRuntime> {
  const central = await getCentralCore();
  const pm = await getProjectManager();

  // Check if already running
  const existing = pm.getRuntime(projectId);
  if (existing) {
    return existing;
  }

  // Get project config from registry
  const project = await central.getProject(projectId);
  if (!project) {
    throw new ProjectResolutionError(`Project "${projectId}" not found.`, "NOT_FOUND", {
      projectId,
    });
  }

  // Add and start the runtime
  const runtime = await pm.addProject({
    projectId: project.id,
    workingDirectory: project.path,
    isolationMode: project.isolationMode,
    maxConcurrent: project.settings?.maxConcurrent ?? 2,
    maxWorktrees: project.settings?.maxWorktrees ?? 4,
  });

  return runtime;
}

/**
 * Stop a project runtime if running.
 */
export async function stopProjectRuntime(projectId: string): Promise<void> {
  const pm = await getProjectManager();
  await pm.removeProject(projectId);
}

/**
 * Get the current runtime status for a project.
 */
export async function getProjectRuntimeStatus(
  projectId: string
): Promise<import("@fusion/engine").RuntimeStatus | "not_started"> {
  const pm = await getProjectManager();
  const runtime = pm.getRuntime(projectId);

  if (!runtime) {
    return "not_started";
  }

  return runtime.getStatus();
}

/**
 * Get the last activity timestamp for a project.
 */
export async function getProjectLastActivity(projectId: string): Promise<string | undefined> {
  const central = await getCentralCore();
  const health = await central.getProjectHealth(projectId);
  return health?.lastActivityAt;
}

/**
 * Get all projects with their runtime status.
 */
export async function getProjectsWithStatus(): Promise<
  Array<{
    project: RegisteredProject;
    runtimeStatus: import("@fusion/engine").RuntimeStatus | "not_started";
    taskCount: number;
  }>
> {
  const central = await getCentralCore();
  const pm = await getProjectManager();

  const projects = await central.listProjects();

  const results = await Promise.all(
    projects.map(async (project) => {
      const runtime = pm.getRuntime(project.id);
      const runtimeStatus = runtime?.getStatus() ?? "not_started";

      // Get task count from store
      let taskCount = 0;
      try {
        const store = new (await import("@fusion/core")).TaskStore(project.path);
        await store.init();
        const tasks = await store.listTasks({ slim: true });
        taskCount = tasks.length;
      } catch {
        // If we can't read tasks, just report 0
      }

      return { project, runtimeStatus, taskCount } as {
        project: RegisteredProject;
        runtimeStatus: import("@fusion/engine").RuntimeStatus | "not_started";
        taskCount: number;
      };
    })
  );

  return results;
}

/**
 * Format a timestamp for display (relative or absolute).
 */
export function formatLastActivity(timestamp?: string): string {
  if (!timestamp) return "never";

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Get the count of tasks by column for a project.
 */
export async function getProjectTaskCounts(
  projectId: string,
  store?: TaskStore
): Promise<Record<string, number>> {
  const taskStore =
    store ??
    (await (async () => {
      const central = await getCentralCore();
      const project = await central.getProject(projectId);
      if (!project) return undefined;
      const s = new (await import("@fusion/core")).TaskStore(project.path);
      await s.init();
      return s;
    })());

  if (!taskStore) return {};

  const tasks = await taskStore.listTasks({ slim: true });
  const counts: Record<string, number> = {};

  for (const task of tasks) {
    counts[task.column] = (counts[task.column] || 0) + 1;
  }

  return counts;
}

/**
 * Get summary information for a project.
 */
export async function getProjectSummaryInfo(
  project: ResolvedProject
): Promise<{
  taskCounts: Record<string, number>;
  lastActivity: string | undefined;
  runtimeStatus: import("@fusion/engine").RuntimeStatus | "not_started";
}> {
  await getCentralCore();
  const pm = await getProjectManager();

  const [taskCounts, lastActivity, runtime] = await Promise.all([
    getProjectTaskCounts(project.projectId, project.store),
    getProjectLastActivity(project.projectId),
    Promise.resolve(pm.getRuntime(project.projectId)),
  ]);

  return {
    taskCounts,
    lastActivity,
    runtimeStatus: runtime?.getStatus() ?? "not_started",
  };
}

// Cleanup on process exit (skip in test environment)
if (process.env.NODE_ENV !== "test" && process.env.VITEST === undefined) {
  process.on("exit", () => {
    // Note: cleanupProjectResolution is async, but process.exit doesn't await
    // This is a best-effort cleanup - the OS will clean up resources anyway
    void cleanupProjectResolution();
  });

  process.on("SIGINT", () => {
    void cleanupProjectResolution().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void cleanupProjectResolution().then(() => process.exit(0));
  });
}

// Add getStore export for backward compatibility with existing code
export async function getStore(options?: { project?: string; cwd?: string }): Promise<TaskStore> {
  const resolved = await resolveProject({
    project: options?.project,
    cwd: options?.cwd,
    interactive: true,
  });
  return resolved.store;
}

// Export getStore as default for backward compatibility
export { getStore as default };

// Re-export types from @fusion/core
export type { RegisteredProject } from "@fusion/core";

// Export internal helpers for tests
export { promptConfirm, promptProjectSelection, createResolvedProject };
