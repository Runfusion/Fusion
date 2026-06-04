export type EntryPointAssignmentMode = "shared" | "per-task-derived" | "project-default" | "existing" | "custom-new";

export interface EntryPointBranchAssignmentInput {
  assignmentMode: EntryPointAssignmentMode;
  resolvedBranch?: string;
  taskSegment?: string;
}

export interface EntryPointBranchAssignment {
  workingBranch?: string;
  mergeTargetBranch?: string;
}

/**
 * Conservative git-ref-safe validation for a branch-group branch name, enforced
 * at the persistence boundary (Fix #11). Branch names flow into shell-adjacent
 * git invocations across the coordinator/merger; rejecting injection-shaped names
 * at group creation blocks the shell-injection path at the source for every
 * downstream sink. Legitimate names (slashes, dots, dashes — e.g. `feature/auth`,
 * `fusion/fn-123`) must still pass; only names that could break out of an arg
 * (whitespace, `$`, backtick, `;`, `|`, `&`, quotes, parens/braces/brackets,
 * angle brackets, leading dash, refspec specials) are rejected.
 */
export function isValidBranchGroupBranchName(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed !== name) return false; // surrounding whitespace
  if (name.length > 255) return false;
  if (name.startsWith("-")) return false;
  if (/\s/.test(name)) return false;
  // Shell / refspec metacharacters that could escape a single git arg.
  if (/[$`;|&<>(){}[\]"'\\!*?~^:]/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("@{")) return false;
  if (name === "@") return false; // git check-ref-format rejects the lone `@`
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("//")) return false; // empty path segments
  // Per-segment git-ref rules: no segment may start with `.` or end with
  // `.lock`, matching `git check-ref-format --branch`.
  for (const segment of name.split("/")) {
    if (segment.length === 0) return false;
    if (segment.startsWith(".")) return false;
    if (segment.endsWith(".lock")) return false;
  }
  const reserved = ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"];
  if (reserved.includes(name)) return false;
  return true;
}

/** Throwing wrapper used at the store persistence boundary. */
export function validateBranchGroupBranchName(name: string): string {
  if (!isValidBranchGroupBranchName(name)) {
    throw new Error(`Invalid branch group branch name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Pure membership filter shared by `TaskStore.listTasksByBranchGroup` and the
 * dashboard list route (Fix #8/#9) so the legacy synthetic-groupId fallback
 * semantics can't drift between the two call sites. Groups created before the
 * membership-identity fix stamped `branchContext.groupId` with a synthetic
 * `<sourceType>:<sourceId>` string instead of the real `BG-` id; this matches
 * both forms. Caller is responsible for sorting.
 */
export function filterTasksByBranchGroup<
  T extends { branchContext?: { groupId?: string } | null },
>(
  tasks: T[],
  group: { id: string; sourceType?: string; sourceId?: string } | null | undefined,
  groupId: string,
): T[] {
  const legacyGroupId =
    group && (group.sourceType === "planning" || group.sourceType === "mission")
      ? `${group.sourceType}:${group.sourceId}`
      : undefined;
  return tasks.filter(
    (task) =>
      task.branchContext?.groupId === groupId ||
      (legacyGroupId !== undefined && task.branchContext?.groupId === legacyGroupId),
  );
}

export function sanitizeBranchSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 48);
}

function normalizeOptionalBranch(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function derivePerTaskBranchName(sharedBranch: string | undefined, taskSegment: string): string | undefined {
  const base = normalizeOptionalBranch(sharedBranch);
  if (!base) return undefined;
  const segment = sanitizeBranchSegment(taskSegment);
  if (!segment) return base;
  return `${base}/${segment}`;
}

export function deriveAutoTaskBranchName(taskId: string, shortName: string): string {
  const base = `fusion/${taskId.toLowerCase()}`;
  const segment = sanitizeBranchSegment(shortName ?? "");
  return segment ? `${base}-${segment}` : base;
}

/**
 * Resolves task branch assignment for entry points with distinct working and merge-target concerns.
 * In shared mode, the shared branch is only a merge target; the working branch is always per-task-derived.
 */
export function resolveEntryPointBranchAssignment(
  input: EntryPointBranchAssignmentInput,
): EntryPointBranchAssignment {
  const { assignmentMode, resolvedBranch, taskSegment = "" } = input;

  switch (assignmentMode) {
    case "shared":
      return {
        workingBranch: derivePerTaskBranchName(resolvedBranch, taskSegment),
        mergeTargetBranch: normalizeOptionalBranch(resolvedBranch),
      };
    case "per-task-derived":
      return {
        workingBranch: derivePerTaskBranchName(resolvedBranch, taskSegment),
        mergeTargetBranch: undefined,
      };
    case "project-default":
      return {
        workingBranch: undefined,
        mergeTargetBranch: undefined,
      };
    case "existing":
    case "custom-new":
      return {
        workingBranch: normalizeOptionalBranch(resolvedBranch),
        mergeTargetBranch: undefined,
      };
  }
}
