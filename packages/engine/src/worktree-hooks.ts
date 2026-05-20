import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const DEFAULT_ALLOWED_BRANCH_PATTERNS = ["^fusion/step-\\d+-[a-z0-9-]+$"] as const;
const COMMIT_MSG_HOOK_MARKER = "# fusion-managed-commit-msg-hook";

function toShellCasePattern(pattern: string): string {
  return pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\d\+/g, "[0-9]*")
    .replace(/\[a-z0-9-\]\+/g, "[a-z0-9-]*");
}

/**
 * Build the shared pre-commit identity-guard hook.
 *
 * The emitted script must stay metadata-driven because linked git worktrees share
 * the common hooks directory. The install-time taskId is intentionally unused in
 * the hook body; each commit resolves its owning task from `fusion-task-id` and
 * lowercases it to stay aligned with canonicalFusionBranchName(taskId).
 */
export function buildIdentityGuardHook(_taskId: string, allowedBranchPatterns: readonly string[] = DEFAULT_ALLOWED_BRANCH_PATTERNS): string {
  const allowChecks = allowedBranchPatterns.map((pattern) => `  ${toShellCasePattern(pattern)}) exit 0 ;;`).join("\n");

  return `#!/bin/sh
set -eu

TASK_FILE=$(git rev-parse --git-path fusion-task-id)

if [ ! -f "$TASK_FILE" ]; then
  exit 0
fi

WORKTREE_TASK_ID=$(cat "$TASK_FILE")
# Keep this canonicalized in lockstep with canonicalFusionBranchName(taskId)
EXPECTED_BRANCH="fusion/$(printf '%s' "$WORKTREE_TASK_ID" | tr '[:upper:]' '[:lower:]')"

if ! HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
  HEAD_BRANCH="detached"
fi

if [ "$HEAD_BRANCH" = "$EXPECTED_BRANCH" ]; then
  exit 0
fi

case "$HEAD_BRANCH" in
${allowChecks}
esac

printf '%s\n' "fusion: refusing commit — worktree owns $WORKTREE_TASK_ID but HEAD is $HEAD_BRANCH" >&2
exit 1
`;
}

async function resolveGitPath(worktreePath: string, gitPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git rev-parse --git-path ${gitPath}`, { cwd: worktreePath, encoding: "utf-8" });
    return resolve(worktreePath, stdout.trim());
  } catch (error) {
    throw new Error(`Failed to resolve git path '${gitPath}' for worktree ${worktreePath}: ${(error as Error).message}`);
  }
}

export function buildCommitMsgTrailerHook(
  taskId: string,
  options: {
    taskPrefix?: string;
    trailerName?: string;
  } = {}
): string {
  const taskPrefix = (options.taskPrefix ?? "FN").trim() || "FN";
  const trailerName = (options.trailerName ?? "Fusion-Task-Id").trim() || "Fusion-Task-Id";

  return `#!/bin/sh
set -eu
${COMMIT_MSG_HOOK_MARKER}
# fusion-task-id-seed: ${taskId}

TASK_FILE=$(git rev-parse --git-path fusion-task-id)
[ -f "$TASK_FILE" ] || exit 0
TASK_ID=$(cat "$TASK_FILE")
[ -n "$TASK_ID" ] || exit 0

PREFIX=${JSON.stringify(taskPrefix)}
case "$TASK_ID" in
  ${taskPrefix}-*) ;;
  *) TASK_ID="$PREFIX-$(printf '%s' "$TASK_ID" | sed -E "s/^${taskPrefix}-//i")" ;;
esac

TRAILER_NAME=${JSON.stringify(trailerName)}

git interpret-trailers \
  --in-place \
  --if-exists doNothing \
  --trailer "$TRAILER_NAME: $TASK_ID" \
  "$1"
`;
}

async function writeFileAtomic(targetPath: string, content: string, mode?: number): Promise<void> {
  await execAsync(`mkdir -p ${JSON.stringify(dirname(targetPath))}`);
  const tmpPath = `${targetPath}.tmp`;
  const current = await fs.readFile(targetPath, "utf-8").catch(() => null);
  if (current === content) return;
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode });
  if (mode != null) await fs.chmod(tmpPath, mode);
  await fs.rename(tmpPath, targetPath);
}

async function installCommitMsgHook(input: {
  worktreePath: string;
  taskId: string;
  taskPrefix: string;
  trailerName: string;
}): Promise<void> {
  const hookPath = await resolveGitPath(input.worktreePath, "hooks/commit-msg");
  const existing = await fs.readFile(hookPath, "utf-8").catch(() => null);
  if (existing && !existing.includes(COMMIT_MSG_HOOK_MARKER)) {
    console.warn(
      `[worktree-hooks] commit-msg hook already exists at ${hookPath}; skipping Fusion trailer hook install for ${input.taskId}`
    );
    return;
  }

  const hook = buildCommitMsgTrailerHook(input.taskId, {
    taskPrefix: input.taskPrefix,
    trailerName: input.trailerName,
  });
  await writeFileAtomic(hookPath, hook, 0o755);
}

export async function installTaskWorktreeIdentityGuard(input: {
  worktreePath: string;
  taskId: string;
  allowedBranchPatterns?: readonly string[];
  commitMsgHookEnabled?: boolean;
  taskPrefix?: string;
  taskAttributionTrailerName?: string;
}): Promise<void> {
  const hook = buildIdentityGuardHook(input.taskId, input.allowedBranchPatterns ?? DEFAULT_ALLOWED_BRANCH_PATTERNS);
  const metadataPath = await resolveGitPath(input.worktreePath, "fusion-task-id");
  const hookPath = await resolveGitPath(input.worktreePath, "hooks/pre-commit");

  await writeFileAtomic(metadataPath, `${input.taskId}\n`);
  await writeFileAtomic(hookPath, hook, 0o755);

  if (input.commitMsgHookEnabled !== false) {
    await installCommitMsgHook({
      worktreePath: input.worktreePath,
      taskId: input.taskId,
      taskPrefix: input.taskPrefix ?? "FN",
      trailerName: input.taskAttributionTrailerName ?? "Fusion-Task-Id",
    });
  }
}
