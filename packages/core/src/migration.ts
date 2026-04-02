/**
 * Migration and First-Run Experience
 *
 * Handles the transition from single-project to multi-project mode:
 * - Detects first-run state (fresh install, needs migration, setup wizard, normal)
 * - Auto-discovers existing .kb/ directories for migration
 * - Coordinates migration to central database
 * - Provides backward compatibility for single-project workflows
 *
 * @module migration
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, basename, dirname } from "node:path";
import type { CentralCore } from "./central-core.js";
import { CentralCore as CentralCoreClass } from "./central-core.js";

// ── Types ────────────────────────────────────────────────────────────

/** First-run state detection results */
export type FirstRunState =
  | "fresh-install"      // No central DB, no .kb/ anywhere
  | "needs-migration"    // No central DB, but .kb/kb.db exists in cwd
  | "setup-wizard"       // Central DB exists but has zero projects
  | "normal-operation";  // Central DB exists with projects

/** Detected project for migration consideration */
export interface DetectedProject {
  /** Absolute path to project directory */
  path: string;
  /** Auto-generated or derived project name */
  name: string;
  /** Whether the project has a valid kb.db */
  hasDb: boolean;
}

/** Result of a migration operation */
export interface MigrationResult {
  /** Whether the migration succeeded */
  success: boolean;
  /** IDs of projects that were registered */
  projectsRegistered: string[];
  /** Error messages for any failures */
  errors: string[];
}

/** Input for setting up a project via the wizard */
export interface ProjectSetupInput {
  /** Project path */
  path: string;
  /** Display name */
  name: string;
  /** Isolation mode preference */
  isolationMode?: "in-process" | "child-process";
}

/** Resolved project context for backward compatibility */
export interface ResolvedContext {
  /** Project ID in central registry */
  projectId: string;
  /** Absolute path to project working directory */
  workingDirectory: string;
  /** Whether running in legacy mode (no central DB) */
  isLegacy: boolean;
}

/** Error thrown when project selection is required but not provided */
export class ProjectRequiredError extends Error {
  constructor(
    message: string,
    public readonly availableProjects: Array<{ id: string; name: string }>
  ) {
    super(message);
    this.name = "ProjectRequiredError";
  }
}

// ── FirstRunDetector ─────────────────────────────────────────────────

/**
 * Detects the first-run state and existing projects for migration.
 *
 * This class determines which startup path to take:
 * - Fresh install → Show setup wizard
 * - Existing single project → Auto-migrate
 * - Already migrated → Normal operation
 */
export class FirstRunDetector {
  private readonly globalDir: string;

  /**
   * Create a FirstRunDetector.
   * @param globalDir — Directory for central database. Defaults to `~/.pi/kb/`.
   */
  constructor(globalDir?: string) {
    this.globalDir = globalDir ?? this.getDefaultGlobalDir();
  }

  /**
   * Detect the current first-run state.
   *
   * Returns one of four states:
   * - `"fresh-install"` — No central DB, no local `.kb/` found
   * - `"needs-migration"` — No central DB, but `.kb/kb.db` exists in cwd
   * - `"setup-wizard"` — Central DB exists but has zero projects
   * - `"normal-operation"` — Central DB exists with one or more projects
   * 
   * @param existingCentral — Optional existing CentralCore instance to use instead of creating a new one
   */
  async detectFirstRunState(existingCentral?: CentralCore): Promise<FirstRunState> {
    const hasCentral = this.hasCentralDb();

    if (!hasCentral) {
      // No central DB - check for local .kb/ in cwd
      const cwd = process.cwd();
      const localKbExists = this.hasKbProject(cwd);
      return localKbExists ? "needs-migration" : "fresh-install";
    }

    // Central DB exists - check if it has projects
    let central: CentralCore | undefined = existingCentral;
    let shouldClose = false;
    
    if (!central) {
      try {
        central = new CentralCoreClass(this.globalDir);
        await central.init();
        shouldClose = true;
      } catch {
        return "setup-wizard";
      }
    }
    
    try {
      const projects = await central.listProjects();
      return projects.length === 0 ? "setup-wizard" : "normal-operation";
    } catch {
      // Central DB exists but is unreadable - treat as setup wizard
      return "setup-wizard";
    } finally {
      if (shouldClose && central) {
        await central.close();
      }
    }
  }

  /**
   * Check if the central database exists.
   */
  hasCentralDb(): boolean {
    const centralDbPath = join(this.globalDir, "kb-central.db");
    return existsSync(centralDbPath);
  }

  /**
   * Get the path to the central database.
   */
  getCentralDbPath(): string {
    return join(this.globalDir, "kb-central.db");
  }

  /**
   * Detect existing projects by walking up the directory tree.
   *
   * Starting from `cwd`, walks up looking for `.kb/kb.db` files.
   * Stops at home directory or root.
   *
   * @param cwd — Starting directory (default: process.cwd())
   * @returns Array of detected projects
   */
  async detectExistingProjects(cwd?: string): Promise<DetectedProject[]> {
    const startDir = cwd ?? process.cwd();
    const projects: DetectedProject[] = [];
    const visited = new Set<string>();

    let current = resolve(startDir);
    const home = homedir();
    const root = dirname(current) === current ? current : "/"; // Handle Windows vs Unix root

    while (current !== home && current !== root) {
      if (visited.has(current)) break;
      visited.add(current);

      if (this.hasKbProject(current)) {
        const name = await this.generateProjectName(current);
        projects.push({
          path: current,
          name,
          hasDb: true,
        });
        // Only detect one project - stop at first match
        break;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return projects;
  }

  /**
   * Generate a project name from git remote or directory name.
   *
   * Priority:
   * 1. Git remote origin URL (extract repo name)
   * 2. Directory basename
   *
   * @param projectPath — Absolute path to project
   * @returns Generated name
   */
  async generateProjectName(projectPath: string): Promise<string> {
    // Try git remote first
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: projectPath, timeout: 5000 }
      );

      const remoteUrl = stdout.trim();
      if (remoteUrl) {
        const name = this.extractRepoName(remoteUrl);
        if (name) return name;
      }
    } catch {
      // Git not available or no remote - fall through to directory name
    }

    // Fallback to directory name
    return basename(projectPath);
  }

  /**
   * Extract repository name from git remote URL.
   *
   * Handles formats:
   * - https://github.com/owner/repo.git → repo
   * - https://github.com/owner/repo → repo
   * - git@github.com:owner/repo.git → repo
   * - git@github.com:owner/repo → repo
   */
  private extractRepoName(remoteUrl: string): string | null {
    // Remove .git suffix
    const withoutGit = remoteUrl.replace(/\.git$/, "");

    // Handle SSH format: git@host:owner/repo
    const sshMatch = withoutGit.match(/:([^/:]+\/([^/]+))$/);
    if (sshMatch) {
      return sshMatch[2];
    }

    // Handle HTTPS format: https://host/owner/repo
    const httpsMatch = withoutGit.match(/\/([^/]+)$/);
    if (httpsMatch) {
      return httpsMatch[1];
    }

    return null;
  }

  /**
   * Check if a directory contains a valid kb project.
   */
  private hasKbProject(dir: string): boolean {
    const kbDir = join(dir, ".kb");
    const dbPath = join(kbDir, "kb.db");

    if (!existsSync(kbDir)) return false;
    if (!existsSync(dbPath)) return false;

    try {
      const stat = statSync(dbPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  private getDefaultGlobalDir(): string {
    return join(homedir(), ".pi", "kb");
  }
}

// ── MigrationCoordinator ─────────────────────────────────────────────

/**
 * Coordinates migration and setup flows.
 *
 * Orchestrates:
 * - Auto-migration of existing single projects
 * - Setup wizard project registration
 * - Idempotent re-runs
 */
export class MigrationCoordinator {
  private readonly central: CentralCore;

  /**
   * Create a MigrationCoordinator.
   * @param central — Initialized CentralCore instance
   */
  constructor(central: CentralCore) {
    this.central = central;
  }

  /**
   * Coordinate the full migration flow based on current state.
   *
   * Detects state and executes appropriate migration path:
   * - needs-migration → Auto-register existing project
   * - setup-wizard → No-op (call completeSetup separately)
   * - others → No-op
   */
  async coordinateMigration(): Promise<MigrationResult> {
    const detector = new FirstRunDetector(this.central.getGlobalDir());
    const state = await detector.detectFirstRunState();

    switch (state) {
      case "needs-migration": {
        // Find the project in cwd
        const projects = await detector.detectExistingProjects(process.cwd());
        if (projects.length === 0) {
          return {
            success: false,
            projectsRegistered: [],
            errors: ["No existing kb project found for migration"],
          };
        }
        return this.registerSingleProject(projects[0].path);
      }

      case "fresh-install":
        return {
          success: true,
          projectsRegistered: [],
          errors: [],
        };

      case "setup-wizard":
      case "normal-operation":
        // No migration needed
        return {
          success: true,
          projectsRegistered: [],
          errors: [],
        };
    }
  }

  /**
   * Register a single existing project (for auto-migration).
   *
   * @param projectPath — Absolute path to project
   * @returns Migration result
   */
  async registerSingleProject(projectPath: string): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      projectsRegistered: [],
      errors: [],
    };

    // Validate path
    if (!isAbsolute(projectPath)) {
      result.errors.push(`Project path must be absolute: ${projectPath}`);
      return result;
    }

    // Check if already registered
    try {
      const existing = await this.central.getProjectByPath(projectPath);
      if (existing) {
        // Already registered - idempotent success
        result.success = true;
        result.projectsRegistered.push(existing.id);
        return result;
      }
    } catch (err) {
      result.errors.push(`Failed to check existing registration: ${(err as Error).message}`);
      return result;
    }

    // Generate unique name
    const detector = new FirstRunDetector(this.central.getGlobalDir());
    const baseName = await detector.generateProjectName(projectPath);
    const uniqueName = await this.ensureUniqueName(baseName);

    // Register the project
    try {
      const project = await this.central.registerProject({
        name: uniqueName,
        path: projectPath,
        isolationMode: "in-process",
      });

      result.success = true;
      result.projectsRegistered.push(project.id);
    } catch (err) {
      result.errors.push(`Failed to register project: ${(err as Error).message}`);
    }

    return result;
  }

  /**
   * Complete setup by registering multiple projects (from wizard).
   *
   * @param projects — Array of project setup inputs
   * @returns Migration result
   */
  async completeSetup(projects: ProjectSetupInput[]): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: true,
      projectsRegistered: [],
      errors: [],
    };

    for (const input of projects) {
      try {
        // Check if already registered
        const existing = await this.central.getProjectByPath(input.path);
        if (existing) {
          result.projectsRegistered.push(existing.id);
          continue;
        }

        // Ensure unique name
        const uniqueName = await this.ensureUniqueName(input.name);

        // Register
        const project = await this.central.registerProject({
          name: uniqueName,
          path: input.path,
          isolationMode: input.isolationMode ?? "in-process",
        });

        result.projectsRegistered.push(project.id);
      } catch (err) {
        result.success = false;
        result.errors.push(`Failed to register ${input.name}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /**
   * Ensure a project name is unique by appending -N suffix if needed.
   */
  private async ensureUniqueName(baseName: string): Promise<string> {
    const existing = await this.central.listProjects();
    const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

    if (!existingNames.has(baseName.toLowerCase())) {
      return baseName;
    }

    // Find unique suffix
    let counter = 1;
    let candidate = `${baseName}-${counter}`;
    while (existingNames.has(candidate.toLowerCase())) {
      counter++;
      candidate = `${baseName}-${counter}`;
    }

    return candidate;
  }
}

// ── BackwardCompat ───────────────────────────────────────────────────

/**
 * Backward compatibility layer for single-project workflows.
 *
 * Ensures existing users with single projects continue working
 * without needing to specify `--project` flags.
 */
export class BackwardCompat {
  private readonly central: CentralCore;

  /**
   * Create a BackwardCompat helper.
   * @param central — Initialized CentralCore instance
   */
  constructor(central: CentralCore) {
    this.central = central;
  }

  /**
   * Resolve project context for a command.
   *
   * Resolution order:
   * 1. If `projectId` provided → look up that project
   * 2. If no `projectId` and single project registered → auto-use it
   * 3. If no `projectId` and multiple projects → throw ProjectRequiredError
   * 4. If no central DB → return legacy mode (use cwd directly)
   *
   * @param cwd — Current working directory
   * @param projectId — Optional explicit project ID/name
   * @returns Resolved context
   * @throws ProjectRequiredError when multiple projects and no selection
   */
  async resolveProjectContext(
    cwd: string,
    projectId?: string
  ): Promise<ResolvedContext> {
    // Check for legacy mode (no central DB)
    const detector = new FirstRunDetector(this.central.getGlobalDir());
    if (!detector.hasCentralDb()) {
      return {
        projectId: "legacy",
        workingDirectory: cwd,
        isLegacy: true,
      };
    }

    // Explicit project ID provided
    if (projectId) {
      const project = await this.findProjectByIdOrName(projectId);
      if (!project) {
        throw new ProjectRequiredError(
          `Project not found: ${projectId}`,
          await this.getAvailableProjects()
        );
      }
      return {
        projectId: project.id,
        workingDirectory: project.path,
        isLegacy: false,
      };
    }

    // No explicit project - check how many are registered
    const projects = await this.central.listProjects();

    if (projects.length === 0) {
      // No projects registered - check if cwd has a current .fusion project or legacy .kb project
      if (this.hasProjectData(cwd)) {
        // Auto-migrate this project
        const coordinator = new MigrationCoordinator(this.central);
        const result = await coordinator.registerSingleProject(cwd);
        if (result.success && result.projectsRegistered.length > 0) {
          const newProject = await this.central.getProject(result.projectsRegistered[0]);
          if (newProject) {
            return {
              projectId: newProject.id,
              workingDirectory: newProject.path,
              isLegacy: false,
            };
          }
        }
      }

      throw new ProjectRequiredError(
        "No projects registered. Run 'fn init' or 'fn project add' to set up a project.",
        []
      );
    }

    if (projects.length === 1) {
      // Single project - auto-use it for backward compatibility
      const project = projects[0];
      return {
        projectId: project.id,
        workingDirectory: project.path,
        isLegacy: false,
      };
    }

    // Multiple projects - require explicit selection
    throw new ProjectRequiredError(
      "Multiple projects registered. Use --project <name> to specify which project to use.",
      projects.map((p) => ({ id: p.id, name: p.name }))
    );
  }

  /**
   * Check if running in legacy mode (no central database).
   */
  async isLegacyMode(): Promise<boolean> {
    const detector = new FirstRunDetector(this.central.getGlobalDir());
    return !detector.hasCentralDb();
  }

  /**
   * Find a project by ID or name (case-insensitive name match).
   */
  private async findProjectByIdOrName(idOrName: string): Promise<import("./types.js").RegisteredProject | undefined> {
    // Try exact ID match first
    const byId = await this.central.getProject(idOrName);
    if (byId) return byId;

    // Try name match (case-insensitive)
    const all = await this.central.listProjects();
    const lower = idOrName.toLowerCase();
    return all.find((p) => p.name.toLowerCase() === lower);
  }

  /**
   * Get list of available projects for error messages.
   */
  private async getAvailableProjects(): Promise<Array<{ id: string; name: string }>> {
    const all = await this.central.listProjects();
    return all.map((p) => ({ id: p.id, name: p.name }));
  }

  /**
   * Check if a directory contains a current .fusion project or legacy .kb project.
   */
  private hasProjectData(dir: string): boolean {
    return this.hasProjectDb(dir, ".fusion") || this.hasProjectDb(dir, ".kb");
  }

  private hasProjectDb(dir: string, folderName: ".fusion" | ".kb"): boolean {
    const projectDir = join(dir, folderName);
    const dbPath = join(projectDir, "kb.db");

    if (!existsSync(projectDir)) return false;
    if (!existsSync(dbPath)) return false;

    try {
      const stat = statSync(dbPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }
}
