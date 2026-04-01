/**
 * First-Run Experience — Setup wizard logic for new users and auto-migration.
 *
 * Handles the transition from single-project to multi-project mode:
 * - Detects if this is a fresh installation (no projects registered)
 * - Auto-detects existing kb projects from current working directory
 * - Guides users through initial project registration
 * - Provides setup state for dashboard wizard UI
 *
 * @example
 * ```typescript
 * const central = new CentralCore();
 * await central.init();
 *
 * const firstRun = new FirstRunExperience(central);
 *
 * if (await firstRun.isFirstRun()) {
 *   const state = await firstRun.getSetupState();
 *   // Show wizard UI with state.detectedProjects
 * }
 * ```
 */

import type {
  SetupState,
  ProjectSetupInput,
  SetupCompletionResult,
  DetectedProject,
  RegisteredProject,
  GlobalSettings,
} from "./types.js";
import type { CentralCore } from "./central-core.js";
import { MigrationOrchestrator } from "./migration-orchestrator.js";
import { realpath } from "node:fs/promises";
import { GlobalSettingsStore } from "./global-settings.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Key in global settings to track if setup is complete */
export const SETUP_COMPLETE_KEY = "setupComplete";

// ── FirstRunExperience Class ─────────────────────────────────────────────

export class FirstRunExperience {
  private centralCore: CentralCore;
  private globalSettingsStore: GlobalSettingsStore;
  private migrationOrchestrator: MigrationOrchestrator;

  /**
   * Create a FirstRunExperience instance.
   * @param centralCore — Initialized CentralCore instance
   * @param globalSettingsStore — GlobalSettingsStore instance
   */
  constructor(centralCore: CentralCore, globalSettingsStore?: GlobalSettingsStore) {
    this.centralCore = centralCore;
    this.globalSettingsStore = globalSettingsStore ?? new GlobalSettingsStore();
    this.migrationOrchestrator = new MigrationOrchestrator(centralCore);
  }

  /**
   * Check if this is a first-run scenario.
   *
   * Returns true if:
   * - No projects are registered in the central database
   * - AND setup has not been marked as complete in global settings
   *
   * This indicates either:
   * - Fresh installation (new user)
   * - Reset central database (existing user starting fresh)
   */
  async isFirstRun(): Promise<boolean> {
    if (!this.centralCore.isInitialized()) {
      return true;
    }

    // Check global settings for setup completion flag
    const globalSettings = await this.globalSettingsStore.getSettings();
    if (globalSettings.setupComplete) {
      return false;
    }

    const projects = await this.centralCore.listProjects();
    return projects.length === 0;
  }

  /**
   * Detect or create the initial project.
   *
   * Tries the following in order:
   * 1. Detect existing kb project from `process.cwd()`
   * 2. If found, auto-register it and return
   * 3. If not found, return guidance for manual setup
   *
   * @returns Detection result with type and optional project
   */
  async detectOrCreateInitialProject(): Promise<
    | { type: "detected"; project: RegisteredProject }
    | { type: "manual-setup"; detectedFromCwd?: DetectedProject[] }
  > {
    const cwd = process.cwd();

    // Try to detect from current directory
    const detected = await this.migrationOrchestrator.detectExistingProjects(
      cwd,
      2 // Shallow scan - just cwd and immediate subdirectories
    );

    // Filter to projects with valid databases
    const validProjects = detected.filter((p) => p.hasDb);

    // Check if there's a project directly in cwd (exact match, not subdirectory)
    // Use realpath to handle macOS /private symlink differences
    const realCwd = await realpath(cwd);
    const projectsWithRealPath = await Promise.all(
      validProjects.map(async (p) => ({
        ...p,
        realPath: await realpath(p.path),
      }))
    );
    const projectInCwd = projectsWithRealPath.find((p) => p.realPath === realCwd);

    if (projectInCwd) {
      // Found a project directly in cwd - auto-register it
      const toRegister = [{ ...projectInCwd, path: projectInCwd.realPath }];
      const registered = await this.migrationOrchestrator.autoRegisterProjects(toRegister);

      if (registered.length > 0) {
        return { type: "detected", project: registered[0] };
      }
    }

    // No project directly in cwd - return manual setup guidance
    // Include any detected projects for user to choose from
    return {
      type: "manual-setup",
      detectedFromCwd: validProjects.length > 0 ? validProjects : undefined,
    };
  }

  /**
   * Get the complete setup state for the wizard UI.
   *
   * Returns all information needed to render the first-run wizard:
   * - Whether this is a first-run scenario
   * - Projects detected on filesystem
   * - Projects already registered
   * - Recommended action based on state
   */
  async getSetupState(): Promise<SetupState> {
    const [isFirstRun, detectedProjects, registeredProjects] = await Promise.all([
      this.isFirstRun(),
      this.migrationOrchestrator.detectExistingProjects(process.cwd(), 3),
      this.centralCore.listProjects(),
    ]);

    const validDetected = detectedProjects.filter((p: DetectedProject) => p.hasDb);
    const hasDetectedProjects = validDetected.length > 0;

    // Determine recommended action
    let recommendedAction: SetupState["recommendedAction"];
    if (hasDetectedProjects) {
      recommendedAction = "auto-detect";
    } else if (isFirstRun) {
      recommendedAction = "create-new";
    } else {
      recommendedAction = "manual-setup";
    }

    return {
      isFirstRun,
      hasDetectedProjects,
      detectedProjects: validDetected,
      registeredProjects,
      recommendedAction,
    };
  }

  /**
   * Complete the setup by registering selected projects.
   *
   * This is the final step of the first-run wizard. It registers the
   * projects selected by the user and marks setup as complete.
   *
   * @param projects — Projects to register
   * @returns Setup completion result
   */
  async completeSetup(
    projects: ProjectSetupInput[]
  ): Promise<SetupCompletionResult> {
    const registered: RegisteredProject[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const project of projects) {
      try {
        // Check if already registered
        const existing = await this.centralCore.getProjectByPath(project.path);
        if (existing) {
          registered.push(existing);
          continue;
        }

        // Register the project
        const newProject = await this.centralCore.registerProject({
          name: project.name,
          path: project.path,
          isolationMode: project.isolationMode ?? "in-process",
        });

        // Activate the project
        const activeProject = await this.centralCore.updateProject(
          newProject.id,
          { status: "active" }
        );

        registered.push(activeProject);
      } catch (err) {
        errors.push({
          path: project.path,
          error: (err as Error).message,
        });
      }
    }

    const success = registered.length > 0 && errors.length === 0;
    const nextSteps: string[] = [];

    if (success) {
      if (registered.length === 1) {
        nextSteps.push(
          `Project "${registered[0].name}" is ready. Run "fn dashboard" to start the web UI.`
        );
      } else {
        nextSteps.push(
          `${registered.length} projects registered. Run "fn project list" to see them all.`
        );
      }
      nextSteps.push('Use "fn project add <path>" to register additional projects.');
    } else {
      if (registered.length > 0) {
        nextSteps.push(
          `${registered.length} project(s) registered successfully, but ${errors.length} failed.`
        );
      }
      nextSteps.push("Check error details above and try again.");
    }

    // Mark setup as complete in global settings if successful
    if (success) {
      await this.globalSettingsStore.updateSettings({ setupComplete: true });
    }

    return {
      success,
      projects: registered,
      nextSteps,
    };
  }
}

// ── Factory Function ───────────────────────────────────────────────────────

/**
 * Create a FirstRunExperience instance.
 * @param centralCore — Initialized CentralCore instance
 * @param globalSettingsStore — Optional GlobalSettingsStore instance
 * @returns FirstRunExperience
 */
export function createFirstRunExperience(
  centralCore: CentralCore,
  globalSettingsStore?: GlobalSettingsStore
): FirstRunExperience {
  return new FirstRunExperience(centralCore, globalSettingsStore);
}
