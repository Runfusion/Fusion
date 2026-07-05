import {
  deriveAutoTaskBranchName,
  derivePerTaskBranchName,
  resolveEntryPointBranchAssignment,
  sanitizeBranchSegment,
} from "@fusion/core";
import type {
  EntryPointAssignmentMode,
  EntryPointBranchAssignment,
  EntryPointBranchAssignmentInput,
} from "@fusion/core";
import { badRequest } from "../api-error.js";

export {
  resolveEntryPointBranchAssignment,
};
export type {
  EntryPointAssignmentMode,
  EntryPointBranchAssignment,
  EntryPointBranchAssignmentInput,
};

export type BranchSelectionMode =
  | "project-default"
  | "auto-new"
  | "existing"
  | "custom-new"
  | "shared-group";

export interface BranchSelectionPayload {
  mode?: unknown;
  branchName?: unknown;
  baseBranch?: unknown;
}

export function getBranchSelectionMode(selectionInput: unknown): BranchSelectionMode | undefined {
  if (selectionInput === undefined || selectionInput === null) return undefined;
  if (typeof selectionInput !== "object" || Array.isArray(selectionInput)) {
    throw badRequest("branchSelection must be an object");
  }
  const selection = selectionInput as BranchSelectionPayload;
  const mode = typeof selection.mode === "string" ? selection.mode : undefined;
  if (!mode) {
    throw badRequest("branchSelection.mode is required");
  }
  if (![
    "project-default",
    "auto-new",
    "existing",
    "custom-new",
    "shared-group",
  ].includes(mode)) {
    throw badRequest("branchSelection.mode must be one of: project-default, auto-new, existing, custom-new, shared-group");
  }
  return mode as BranchSelectionMode;
}

export type PlanningBranchMode = "shared" | "per-task-derived";

export interface ResolvedBranchSelection {
  branch?: string;
  baseBranch?: string;
  sharedFeatureBranch?: string;
}

export interface BranchAssignmentContext {
  mode?: unknown;
}

export interface ResolvedBranchAssignmentContext {
  /** undefined when the request did not specify a mode; callers pick their own default. */
  mode: PlanningBranchMode | undefined;
}

function normalizeOptionalBranch(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw badRequest(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveBranchSelection(
  selectionInput: unknown,
  fallbackBranch: unknown,
  fallbackBaseBranch: unknown,
): ResolvedBranchSelection {
  const fallback = {
    branch: normalizeOptionalBranch(fallbackBranch, "branch"),
    baseBranch: normalizeOptionalBranch(fallbackBaseBranch, "baseBranch"),
  };

  if (selectionInput === undefined || selectionInput === null) {
    return fallback;
  }

  const mode = getBranchSelectionMode(selectionInput);
  const selection = selectionInput as BranchSelectionPayload;

  const baseBranch = normalizeOptionalBranch(selection.baseBranch, "branchSelection.baseBranch");

  if (mode === "project-default") {
    return { branch: undefined, baseBranch };
  }

  if (mode === "auto-new") {
    // Auto-named branch is derived later by existing task-id based flow.
    return { branch: undefined, baseBranch };
  }

  const branchName = normalizeOptionalBranch(selection.branchName, "branchSelection.branchName");

  if (mode === "shared-group") {
    if (!branchName) {
      throw badRequest("branchSelection.branchName is required for shared-group mode");
    }
    return {
      branch: undefined,
      baseBranch,
      sharedFeatureBranch: branchName,
    };
  }

  if (!branchName) {
    throw badRequest("branchSelection.branchName is required for existing/custom-new modes");
  }

  return {
    branch: branchName,
    baseBranch,
  };
}

export function resolveBranchAssignmentContext(input: unknown): ResolvedBranchAssignmentContext {
  if (input === undefined || input === null) {
    // No explicit assignment requested: leave mode undefined so callers can
    // apply their own default (e.g. mission triage falls back to the
    // mission's branchStrategy instead of being forced into a shared group).
    return { mode: undefined };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw badRequest("branchAssignment must be an object");
  }
  const payload = input as BranchAssignmentContext;
  const mode = payload.mode;
  if (mode !== undefined && mode !== "shared" && mode !== "per-task-derived") {
    throw badRequest("branchAssignment.mode must be one of: shared, per-task-derived");
  }
  return { mode };
}

export function sanitizeSegment(input: string): string {
  return sanitizeBranchSegment(input);
}

export function deriveAutoTaskBranch(taskId: string, shortName: string): string {
  return deriveAutoTaskBranchName(taskId, shortName);
}

export function derivePerTaskBranch(sharedBranch: string | undefined, taskSegment: string): string | undefined {
  const base = normalizeOptionalBranch(sharedBranch, "sharedBranch");
  return derivePerTaskBranchName(base, taskSegment);
}
