import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const DEFAULT_ALLOWED_BRANCH_PATTERNS = ["^fusion/step-\\d+-[a-z0-9-]+$"] as const;

function toShellCasePattern(pattern: string): string {
  return pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\d\+/g, "[0-9]*")
    .replace(/\[a-z0-9-\]\+/g, "[a-z0-9-]*");
}

export function buildIdentityGuardHook(taskId: string, allowedBranchPatterns: readonly string[] = DEFAULT_ALLOWED_BRANCH_PATTERNS): string {
  const allowChecks = allowedBranchPatterns.map((pattern) => `  ${toShellCasePattern(pattern)}) exit 0 ;;`).join("\n");

  return `#!/bin/sh
set -eu

TASK_FILE=$(git rev-parse --git-path fusion-task-id)

if [ ! -f "$TASK_FILE" ]; then
  exit 0
fi

WORKTREE_TASK_ID=$(cat "$TASK_FILE")
EXPECTED_BRANCH="fusion/${taskId.toLowerCase()}"

if ! HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
  HEAD_BRANCH="detached"
fi

if [ "$WORKTREE_TASK_ID" != "${taskId}" ] && [ "$WORKTREE_TASK_ID" != "${taskId.toLowerCase()}" ]; then
  EXPECTED_BRANCH="fusion/$(printf '%s\n' "$WORKTREE_TASK_ID" | tr '[:upper:]' '[:lower:]')"
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

async function writeFileAtomic(targetPath: string, content: string, mode?: number): Promise<void> {
  await execAsync(`mkdir -p ${JSON.stringify(dirname(targetPath))}`);
  const tmpPath = `${targetPath}.tmp`;
  const current = await fs.readFile(targetPath, "utf-8").catch(() => null);
  if (current === content) return;
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode });
  if (mode != null) await fs.chmod(tmpPath, mode);
  await fs.rename(tmpPath, targetPath);
}

export async function installTaskWorktreeIdentityGuard(input: {
  worktreePath: string;
  taskId: string;
  allowedBranchPatterns?: readonly string[];
}): Promise<void> {
  const hook = buildIdentityGuardHook(input.taskId, input.allowedBranchPatterns ?? DEFAULT_ALLOWED_BRANCH_PATTERNS);
  const metadataPath = await resolveGitPath(input.worktreePath, "fusion-task-id");
  const hookPath = await resolveGitPath(input.worktreePath, "hooks/pre-commit");

  await writeFileAtomic(metadataPath, `${input.taskId}\n`);
  await writeFileAtomic(hookPath, hook, 0o755);
}
