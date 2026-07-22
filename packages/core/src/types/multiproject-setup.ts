/**
 * FNXC:CodeOrganization 2026-07-22-14:00:
 * Multi-project first-run setup and migration types peeled from types.ts.
 */

import type { RegisteredProject } from "./archive-planning.js";

// ── Multi-Project First-Run & Migration Types ───────────────────────────────

/** Detected project for migration consideration */
export interface DetectedProject {
  /** Absolute path to project directory */
  path: string;
  /** Auto-generated or derived project name */
  name: string;
  /** Whether the project has a valid fusion.db */
  hasDb: boolean;
  /** Persisted project identity id if present */
  identityId?: string;
}

/** Setup state for the first-run wizard UI */
export interface SetupState {
  /** Whether this is a first-run scenario (no projects registered) */
  isFirstRun: boolean;
  /** Whether any projects were detected on the filesystem */
  hasDetectedProjects: boolean;
  /** Projects detected on filesystem for potential registration */
  detectedProjects: DetectedProject[];
  /** Projects already registered in the central database */
  registeredProjects: RegisteredProject[];
  /** Recommended action based on current state */
  recommendedAction: "auto-detect" | "create-new" | "manual-setup";
  /** Local identities whose central rows are missing */
  orphanIdentities?: Array<{ path: string; identityId: string }>;
}

/** Input for setting up a project via the wizard */
export interface ProjectSetupInput {
  /** Project path */
  path: string;
  /** Display name */
  name: string;
  /** Isolation mode preference */
  isolationMode?: "in-process" | "child-process";
  /** Persisted local identity for central re-attachment */
  identity?: { id: string; createdAt: string } | null;
}

/** Result of completing the first-run setup */
export interface SetupCompletionResult {
  /** Whether the setup completed successfully */
  success: boolean;
  /** Projects that were registered */
  projects: RegisteredProject[];
  /** Recommended next steps for the user */
  nextSteps: string[];
}

/** Options for running a migration */
export interface MigrationOptions {
  /** Path to start scanning for projects (default: process.cwd()) */
  startPath?: string;
  /** Maximum recursion depth for scanning (default: 5) */
  maxDepth?: number;
  /** Whether to simulate without making changes */
  dryRun?: boolean;
  /** Whether to auto-register detected projects */
  autoRegister?: boolean;
  /** Progress callback for long-running operations */
  onProgress?: (current: number, total: number, path: string) => void;
}

/** Result of a migration operation (from MigrationOrchestrator) */
export interface MigrationResult {
  /** Projects detected during scanning */
  projectsDetected: DetectedProject[];
  /** Projects that were registered */
  projectsRegistered: RegisteredProject[];
  /** Projects that were skipped with reasons */
  projectsSkipped: Array<{ path: string; reason: string }>;
  /** Errors encountered during migration */
  errors: Array<{ path: string; error: string }>;
}


