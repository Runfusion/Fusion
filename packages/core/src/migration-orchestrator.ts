/**
 * Migration Orchestrator — Coordinates auto-migration from single-project to multi-project mode.
 *
 * Detects existing kb projects on the filesystem and automatically registers them
 * in the central project registry. Provides safety checks, progress callbacks,
 * and dry-run capabilities.
 *
 * @example
 * ```typescript
 * const central = new CentralCore();
 * await central.init();
 *
 * const orchestrator = new MigrationOrchestrator(central);
 *
 * // Check if migration is needed
 * if (await orchestrator.needsMigration()) {
 *   // Run migration with auto-registration
 *   const result = await orchestrator.runMigration({ autoRegister: true });
 *   console.log(`Registered ${result.projectsRegistered.length} projects`);
 * }
 * ```
 */

import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, basename, normalize, resolve, sep } from "node:path";
import type {
  DetectedProject,
  MigrationOptions,
  MigrationResult,
  RegisteredProject,
} from "./types.js";
import type { CentralCore } from "./central-core.js";
import { isValidSqliteDatabaseFile } from "./sqlite-validation.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of projects to auto-register (safety limit) */
export const MAX_AUTO_REGISTER_PROJECTS = 100;

/** Default maximum scan depth */
export const DEFAULT_MAX_DEPTH = 5;

/** Directories to exclude from scanning */
export const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  "out",
  ".worktrees",
  ".next",
  ".turbo",
  ".npm",
  ".pnpm-store",
  "coverage",
  ".nyc_output",
  "tmp",
  "temp",
];

/** Check if a directory name should be excluded from scanning */
function isExcludedDir(name: string): boolean {
  // Exclude hidden directories (starting with .) and known build/cache directories
  if (name.startsWith(".")) return true;
  return EXCLUDED_DIRS.includes(name.toLowerCase());
}

/** Check if a path is within another path (circular detection) */
function isPathWithin(child: string, parent: string): boolean {
  const normalizedChild = normalize(child);
  const normalizedParent = normalize(parent);
  // Ensure both paths end with platform-specific separator for proper prefix matching
  const childWithSep = normalizedChild.endsWith(sep) ? normalizedChild : normalizedChild + sep;
  const parentWithSep = normalizedParent.endsWith(sep) ? normalizedParent : normalizedParent + sep;
  return childWithSep.startsWith(parentWithSep);
}

// ── MigrationOrchestrator Class ───────────────────────────────────────────

export class MigrationOrchestrator {
  private centralCore: CentralCore;

  /**
   * Create a MigrationOrchestrator instance.
   * @param centralCore — Initialized CentralCore instance
   */
  constructor(centralCore: CentralCore) {
    this.centralCore = centralCore;
  }

  /**
   * Detect existing kb projects by walking the filesystem.
   *
   * Scans from the starting path up to maxDepth levels deep, looking for
   * directories containing `.fusion/fusion.db` (or legacy `.fusion/fusion.db`)
   *
   * Security notes:
   * - Only scans from the specified startPath
   * - Respects maxDepth to prevent deep recursion
   * - Skips hidden directories and common build/cache directories
   * - Does not follow symbolic links
   *
   * @param startPath — Directory to start scanning from
   * @param maxDepth — Maximum recursion depth (default: 5)
   * @returns Array of detected projects
   */
  async detectExistingProjects(
    startPath: string = process.cwd(),
    maxDepth: number = DEFAULT_MAX_DEPTH
  ): Promise<DetectedProject[]> {
    // Check if path is relative BEFORE resolving
    if (!isAbsolute(startPath)) {
      throw new Error(`Scan path must be absolute: ${startPath}`);
    }

    const scanPath = resolve(startPath);

    if (!existsSync(scanPath)) {
      throw new Error(`Scan path does not exist: ${scanPath}`);
    }

    const detected: DetectedProject[] = [];
    const visited = new Set<string>();

    await this.scanDirectory(scanPath, 0, maxDepth, detected, visited);

    // Sort by path for consistent ordering
    detected.sort((a, b) => a.path.localeCompare(b.path));

    return detected;
  }

  /**
   * Recursively scan a directory for kb projects.
   */
  private async scanDirectory(
    dir: string,
    depth: number,
    maxDepth: number,
    detected: DetectedProject[],
    visited: Set<string>
  ): Promise<void> {
    // Prevent infinite loops from symlinks or circular references
    const normalizedDir = normalize(dir);
    if (visited.has(normalizedDir)) {
      return;
    }
    visited.add(normalizedDir);

    // Respect depth limit
    if (depth > maxDepth) {
      return;
    }

    // Check if this directory is a kb project (has .fusion/fusion.db or .fusion/fusion.db)
    const hasKbDb = this.isKbProject(dir);
    if (hasKbDb) {
      const name = this.generateProjectName(dir);
      detected.push({
        path: dir,
        name,
        hasDb: true,
      });
      // Don't recurse into kb projects - they're project roots
      return;
    }

    // Try to read directory entries
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Permission denied or other error - skip this directory
      return;
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (isExcludedDir(entry)) {
        continue;
      }

      const fullPath = join(dir, entry);

      // Skip symlinks to avoid cycles
      try {
        const stats = statSync(fullPath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          continue;
        }
      } catch {
        // Can't stat - skip
        continue;
      }

      await this.scanDirectory(fullPath, depth + 1, maxDepth, detected, visited);
    }
  }

  /**
   * Check if a directory contains a valid kb project.
   * Validates that .fusion/fusion.db is an openable SQLite database.
   */
  private isKbProject(dir: string): boolean {
    return isValidSqliteDatabaseFile(join(dir, ".fusion", "fusion.db"));
  }

  /**
   * Generate a project name from a directory path.
   * Uses the basename of the directory.
   */
  private generateProjectName(dir: string): string {
    return basename(dir);
  }

  /**
   * Auto-register detected projects in the central registry.
   *
   * - Filters to projects with valid fusion.db
   * - Skips already-registered projects
   * - Generates unique names (appends number if conflict: name, name-2, name-3)
   * - Sets isolationMode to 'in-process' for migrated projects
   * - Enforces MAX_AUTO_REGISTER_PROJECTS limit
   *
   * @param detected — Projects detected during scan
   * @returns Array of newly registered projects
   */
  async autoRegisterProjects(detected: DetectedProject[]): Promise<RegisteredProject[]> {
    const registered: RegisteredProject[] = [];
    const existingProjects = await this.centralCore.listProjects();

    // Safety limit check
    if (detected.length > MAX_AUTO_REGISTER_PROJECTS) {
      throw new Error(
        `Too many projects detected (${detected.length}). ` +
          `Maximum allowed for auto-registration is ${MAX_AUTO_REGISTER_PROJECTS}. ` +
          `Register projects manually using 'fn project add <path>'.`
      );
    }

    for (const project of detected) {
      // Skip if no valid database
      if (!project.hasDb) {
        continue;
      }

      // Skip if already registered by path
      const existingByPath = existingProjects.find(
        (p: import("./types.js").RegisteredProject) => normalize(p.path) === normalize(project.path)
      );
      if (existingByPath) {
        continue;
      }

      // Check for circular registration (project inside another registered project)
      const circularParent = existingProjects.find(
        (p: import("./types.js").RegisteredProject) => isPathWithin(project.path, p.path) || isPathWithin(p.path, project.path)
      );
      if (circularParent) {
        continue;
      }

      // Generate unique name
      const uniqueName = await this.generateUniqueName(project.name, [
        ...existingProjects.map((p: import("./types.js").RegisteredProject) => p.name),
        ...registered.map((p: import("./types.js").RegisteredProject) => p.name),
      ]);

      try {
        const newProject = await this.centralCore.registerProject({
          name: uniqueName,
          path: project.path,
          isolationMode: "in-process",
        });

        // Update status to active (registration sets it to 'initializing')
        const activeProject = await this.centralCore.updateProject(newProject.id, { status: "active" });

        registered.push(activeProject);
      } catch (err) {
        // Log but continue with other projects
        console.warn(`[migration] Failed to register ${project.path}:`, (err as Error).message);
      }
    }

    return registered;
  }

  /**
   * Generate a unique project name, appending a number suffix if needed.
   * Format: name, name-2, name-3, etc.
   */
  private async generateUniqueName(baseName: string, existingNames: string[]): Promise<string> {
    const lowerExisting = new Set(existingNames.map((n) => n.toLowerCase()));

    if (!lowerExisting.has(baseName.toLowerCase())) {
      return baseName;
    }

    let counter = 2;
    let candidate = `${baseName}-${counter}`;

    while (lowerExisting.has(candidate.toLowerCase())) {
      counter++;
      candidate = `${baseName}-${counter}`;
    }

    return candidate;
  }

  /**
   * Check if migration is needed.
   *
   * Returns true if:
   * - Central database exists but has no projects registered
   * - AND there are existing kb projects on the filesystem
   *
   * This indicates a first-run scenario where we should auto-migrate.
   *
   * @param startPath — Optional path to scan for projects (default: process.cwd())
   */
  async needsMigration(startPath?: string): Promise<boolean> {
    // Check if central core is initialized
    if (!this.centralCore.isInitialized()) {
      return true;
    }

    // Check if any projects are already registered
    const projects = await this.centralCore.listProjects();
    if (projects.length > 0) {
      return false;
    }

    // Check if there are any legacy projects to migrate
    const scanPath = startPath ?? process.cwd();
    const detected = await this.detectExistingProjects(scanPath, 3); // Shallow scan
    return detected.length > 0;
  }

  /**
   * Run the full migration process.
   *
   * Orchestrates detection → registration → validation with progress
   * callbacks and dry-run support.
   *
   * @param options — Migration options
   * @returns Migration result with details
   */
  async runMigration(options?: MigrationOptions): Promise<MigrationResult> {
    const result: MigrationResult = {
      projectsDetected: [],
      projectsRegistered: [],
      projectsSkipped: [],
      errors: [],
    };

    const startPath = options?.startPath ?? process.cwd();
    const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
    const dryRun = options?.dryRun ?? false;

    // Phase 1: Detection
    try {
      result.projectsDetected = await this.detectExistingProjects(startPath, maxDepth);
    } catch (err) {
      result.errors.push({
        path: startPath,
        error: `Detection failed: ${(err as Error).message}`,
      });
      return result;
    }

    // Report progress after detection
    if (options?.onProgress) {
      options.onProgress(0, result.projectsDetected.length, "Detection complete");
    }

    // Phase 2: Registration (or dry-run simulation)
    if (dryRun) {
      // In dry-run mode, simulate what would be registered
      const existingProjects = await this.centralCore.listProjects();

      for (const project of result.projectsDetected) {
        if (!project.hasDb) {
          result.projectsSkipped.push({ path: project.path, reason: "No valid kb database" });
          continue;
        }

        const existingByPath = existingProjects.find(
          (p: import("./types.js").RegisteredProject) => normalize(p.path) === normalize(project.path)
        );
        if (existingByPath) {
          result.projectsSkipped.push({ path: project.path, reason: "Already registered" });
          continue;
        }

        // Would be registered in non-dry-run mode
        result.projectsSkipped.push({ path: project.path, reason: "[DRY RUN] Would register" });
      }
    } else if (options?.autoRegister) {
      // Auto-register detected projects
      try {
        const registered = await this.autoRegisterProjects(result.projectsDetected);
        result.projectsRegistered = registered;

        // Track skipped projects
        const registeredPaths = new Set(registered.map((p) => normalize(p.path)));
        for (const project of result.projectsDetected) {
          if (!registeredPaths.has(normalize(project.path))) {
            // Determine why it was skipped
            if (!project.hasDb) {
              result.projectsSkipped.push({ path: project.path, reason: "No valid kb database" });
            } else {
              result.projectsSkipped.push({ path: project.path, reason: "Already registered or error" });
            }
          }

          if (options?.onProgress) {
            const current = result.projectsDetected.indexOf(project) + 1;
            options.onProgress(current, result.projectsDetected.length, project.path);
          }
        }
      } catch (err) {
        result.errors.push({
          path: "registration",
          error: (err as Error).message,
        });
      }
    } else {
      // Detection only mode - mark all as "would register"
      for (const project of result.projectsDetected) {
        if (!project.hasDb) {
          result.projectsSkipped.push({ path: project.path, reason: "No valid kb database" });
        } else {
          result.projectsSkipped.push({
            path: project.path,
            reason: "Detection only (autoRegister not enabled)",
          });
        }
      }
    }

    return result;
  }
}

// ── Factory Function ───────────────────────────────────────────────────────

/**
 * Create a MigrationOrchestrator instance.
 * @param centralCore — Initialized CentralCore instance
 * @returns MigrationOrchestrator
 */
export function createMigrationOrchestrator(centralCore: CentralCore): MigrationOrchestrator {
  return new MigrationOrchestrator(centralCore);
}
