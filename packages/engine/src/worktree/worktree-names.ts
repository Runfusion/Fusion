import { readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { classifyTaskBranchOrigin, deriveWorkspaceTaskDirSegment, slugifyWorktreeSegment } from "@fusion/core";
import type { Settings, Task, WorkspaceWorktreeContext } from "@fusion/core";
import { resolveTaskWorktreePath, resolveWorktreesDir } from "./worktree-paths.js";

export const ADJECTIVES = [
  "amber", "azure", "bold", "brave", "bright",
  "calm", "clear", "cool", "coral", "crisp",
  "deft", "dusky", "eager", "early", "faint",
  "fast", "fleet", "fresh", "gentle", "gilt",
  "glad", "grand", "green", "happy", "hazy",
  "ivory", "jade", "keen", "lemon", "light",
  "lunar", "maple", "merry", "misty", "noble",
  "opal", "pale", "pearl", "plush", "proud",
  "quiet", "rapid", "rosy", "rusty", "sandy",
  "sharp", "sleek", "solar", "swift", "vivid",
];

export const NOUNS = [
  "aspen", "badger", "breeze", "brook", "cedar",
  "cliff", "crane", "creek", "daisy", "delta",
  "dune", "eagle", "ember", "falcon", "fern",
  "finch", "flame", "frost", "grove", "hawk",
  "heron", "iris", "lark", "lotus", "marsh",
  "mesa", "moss", "oak", "olive", "orbit",
  "otter", "panda", "peach", "petal", "pine",
  "plume", "quail", "raven", "reef", "ridge",
  "robin", "sage", "shore", "spark", "stone",
  "thorn", "tiger", "trail", "trout", "wren",
];

export function canonicalFusionBranchName(taskId: string): string {
  return `fusion/${taskId.toLowerCase()}`;
}

/**
 * Canonical per-instance branch name for a worktree-isolated foreach step.
 * The branch is deterministic from the task id and step index so a resumed
 * workflow can reconstruct it without allocating a name.
 */
export function canonicalStepInstanceBranchName(taskId: string, stepIndex: number): string {
  return `${canonicalFusionBranchName(taskId)}-step-${stepIndex}`;
}

export function resolveTaskWorkingBranch(task: Pick<Task, "id" | "branch" | "branchContext">): string {
  if (task.branchContext?.assignmentMode === "shared") {
    return canonicalFusionBranchName(task.id);
  }
  return task.branch || canonicalFusionBranchName(task.id);
}

/**
 * FNXC:WorkspaceBranches 2026-08-20-03:38:
 * FN-9161 requires recorded provenance rather than name shape: an operator
 * branch may intentionally use Fusion's namespace.
 */
export function resolveTaskWorkingBranchWithOrigin(
  task: Pick<Task, "id" | "branch" | "branchContext">,
): { branch: string; origin: ReturnType<typeof classifyTaskBranchOrigin> } {
  const branch = resolveTaskWorkingBranch(task);
  return { branch, origin: classifyTaskBranchOrigin(task, branch) };
}

/**
 * Convert a string to a URL-friendly slug.
 *
 * - Lowercase
 * - Replace spaces, underscores, and special chars with hyphens
 * - Collapse multiple hyphens
 * - Trim leading/trailing hyphens
 */
export function slugify(str: string): string {
  // FNXC:WorkspaceWorktree 2026-08-24-06:11: one slug implementation, shared with core's workspace
  // task-directory derivation, so a single-repository worktree and a workspace task directory can
  // never drift apart in spelling for the same input.
  return slugifyWorktreeSegment(str);
}

/**
 * Generate a random, human-friendly worktree directory name.
 *
 * Names follow an `adjective-noun` pattern (e.g., `swirly-monkey`,
 * `quiet-falcon`, `bright-orchid`) drawn from embedded word lists of
 * ~50 adjectives × ~50 nouns, producing ~2,500 unique combinations.
 *
 * **Collision avoidance:** The function checks existing subdirectories
 * under the configured worktrees root. If the randomly chosen name already
 * exists, a numeric suffix is appended (e.g., `swift-falcon-2`) until a unique
 * name is found.
 *
 * @param rootDir - The project root directory (parent of the worktrees root)
 * @returns A unique worktree directory name (not a full path)
 */
export function generateWorktreeName(rootDir: string, settings?: Pick<Settings, "worktreesDir">, workspaceContext?: WorkspaceWorktreeContext): string {
  return generateReservedWorktreeName(rootDir, new Set(), settings, workspaceContext);
}

/**
 * Generate a unique worktree directory name while also avoiding names that
 * have been reserved in-memory but may not exist on disk yet.
 */
export function generateReservedWorktreeName(
  rootDir: string,
  reservedNames: Set<string> = new Set(),
  settings?: Pick<Settings, "worktreesDir">,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const baseName = `${adjective}-${noun}`;

  const worktreesDir = resolveWorktreesDir(rootDir, settings, workspaceContext);
  const existing = getExistingWorktreeNames(worktreesDir);
  for (const reserved of reservedNames) {
    existing.add(reserved);
  }

  if (!existing.has(baseName)) {
    return baseName;
  }

  let suffix = 2;
  while (existing.has(`${baseName}-${suffix}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
}

/**
 * Plan a worktree directory path for a task that is about to enter
 * `in-progress`. Returns the absolute path under the configured worktrees root.
 *
 * FNXC:TaskWorktreeNames 2026-09-04-04:42:
 * FN-258 made the lower-cased task ID the only directory identity. This PR restores
 * `worktreeNaming` so a ticket-derived `branch` mode can name workspace and single-repo
 * checkouts, without changing FN-258's shipped default: an unset or unknown mode still
 * uses the task ID. Callers keep the FN-258 argument order (`reservedNames`, then
 * `settings`); naming is read from `settings.worktreeNaming`.
 *
 * Shared by the scheduler dispatch path and the manual-move HTTP route
 * so both allocate via the same collision rules.
 */
export function planTaskWorktreePath(
  task: { id: string; title?: string | null; description?: string; worktree?: string | null; branch?: string | null; branchContext?: Task["branchContext"] },
  rootDir: string,
  reservedNames?: Set<string>,
  settings?: Pick<Settings, "worktreesDir" | "worktreeNaming">,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  const names = reservedNames ?? new Set<string>();
  if (task.worktree) {
    const existingName = task.worktree.split("/").filter(Boolean).pop();
    if (existingName) names.add(existingName);
    return task.worktree;
  }

  let worktreeName: string;
  switch (settings?.worktreeNaming || "task-id") {
    case "task-title":
      worktreeName = slugify(task.title || (task.description ?? "").slice(0, 60) || task.id);
      break;
    /*
    FNXC:WorkspaceWorktree 2026-08-24-06:11:
    R14: the single-repository path honors "branch" through the same degrade-never-reject ladder as
    the workspace path, so selecting the mode cannot silently fall through to a random name. An
    unusable branch slug lands on the task id rather than failing dispatch.
    */
    case "branch":
      worktreeName = deriveWorkspaceTaskDirSegment({
        taskId: task.id,
        worktreeNaming: "branch",
        branch: resolveTaskWorkingBranch({ id: task.id, branch: task.branch ?? undefined, branchContext: task.branchContext }),
        siblingSegments: names,
      }).segment;
      break;
    case "random":
      worktreeName = generateReservedWorktreeName(rootDir, names, settings, workspaceContext);
      break;
    case "task-id":
    default:
      worktreeName = task.id.toLowerCase();
      break;
  }

  names.add(worktreeName);
  return resolveTaskWorktreePath(rootDir, settings, worktreeName, workspaceContext);
}

function getExistingWorktreeNames(worktreesDir: string): Set<string> {
  if (!existsSync(worktreesDir)) {
    return new Set();
  }
  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}
