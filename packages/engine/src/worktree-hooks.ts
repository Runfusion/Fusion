import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const DEFAULT_ALLOWED_BRANCH_PATTERNS = ["^fusion/step-\\d+-[a-z0-9-]+$"] as const;

/**
 * Env-var marker the merger sets around its own `git commit` calls to bypass
 * the identity-guard hook on detached HEAD. Kept in sync with the literal in
 * `buildIdentityGuardHook` below; the hook gates strictly to the value "1".
 */
export const IDENTITY_GUARD_BYPASS_ENV = "FUSION_MERGER_BYPASS_IDENTITY_GUARD";
const COMMIT_MSG_HOOK_MARKER = "# fusion-managed-commit-msg-hook";
const PREPARE_COMMIT_MSG_HOOK_MARKER = "# fusion-managed-prepare-commit-msg-hook";
export const DEFAULT_COMMIT_AUTHOR_NAME = "Fusion";
export const DEFAULT_COMMIT_AUTHOR_EMAIL = "noreply@runfusion.ai";

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
 * The emitted script must stay metadata-aware because linked git worktrees share
 * the common hooks directory. It bakes in the install-time taskId as the default
 * expected branch, then falls back to `fusion-task-id` when runtime metadata
 * drifts so the shared hook still follows the current owning task.
 */
export function buildIdentityGuardHook(taskId: string, allowedBranchPatterns: readonly string[] = DEFAULT_ALLOWED_BRANCH_PATTERNS): string {
  const allowChecks = allowedBranchPatterns.map((pattern) => `  ${toShellCasePattern(pattern)}) exit 0 ;;`).join("\n");

  return `#!/bin/sh
set -eu

TASK_FILE=$(git rev-parse --git-path fusion-task-id)

if [ ! -f "$TASK_FILE" ]; then
  exit 0
fi

# Merger bypass: the merger commits on a detached HEAD during
# reuse-task-worktree squash and verification-fix ceremonies. Gated to the
# exact value "1" so a leaked/empty var cannot accidentally bypass agent
# commits. Placed after the TASK_FILE check (non-fusion worktrees stay
# no-op) and before EXPECTED_BRANCH (detached HEAD never reaches refusal).
if [ "\${${IDENTITY_GUARD_BYPASS_ENV}:-}" = "1" ]; then
  if HEAD_BRANCH_DIAG=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
    :
  else
    HEAD_BRANCH_DIAG="detached"
  fi
  printf '%s\n' "fusion: identity-guard bypass honored for merger commit on $HEAD_BRANCH_DIAG" >&2
  exit 0
fi

# Note: empty-commit refusal (FN-5345/FN-5377) lives in the
# prepare-commit-msg hook (installed by installTaskWorktreeIdentityGuard).
# That hook gets the commit-source argument and can distinguish 'amend' /
# 'merge' / 'squash' (which legitimately may produce empty commits) from
# new commits with --allow-empty.

WORKTREE_TASK_ID=$(cat "$TASK_FILE")
# Keep this canonicalized in lockstep with canonicalFusionBranchName(taskId)
EXPECTED_BRANCH=${JSON.stringify(`fusion/${taskId.toLowerCase()}`)}

if [ "$(printf '%s' "$WORKTREE_TASK_ID" | tr '[:upper:]' '[:lower:]')" != ${JSON.stringify(taskId.toLowerCase())} ]; then
  EXPECTED_BRANCH="fusion/$(printf '%s' "$WORKTREE_TASK_ID" | tr '[:upper:]' '[:lower:]')"
fi

if ! HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
  HEAD_BRANCH="detached"
fi

HEAD_BRANCH_CANONICAL=$(printf '%s' "$HEAD_BRANCH" | tr '[:upper:]' '[:lower:]')
EXPECTED_BRANCH_CANONICAL=$(printf '%s' "$EXPECTED_BRANCH" | tr '[:upper:]' '[:lower:]')

if [ "$HEAD_BRANCH_CANONICAL" = "$EXPECTED_BRANCH_CANONICAL" ]; then
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

/**
 * Build the shared prepare-commit-msg empty-commit guard hook.
 *
 * Refuses to author empty commits in fusion-managed task worktrees. A
 * verification-only task that finds no repro should leave own-commits at 0
 * and let the merger's empty-own-diff / proven-no-op classifier finalize it.
 * Manufacturing an empty handoff commit (e.g. `git commit --allow-empty`)
 * defeats that classifier and wedges the task in the merge path (FN-5345).
 *
 * prepare-commit-msg gets the commit-source argument so we can correctly
 * allow legitimate empty commits during amend / merge / squash / template
 * paths and only refuse new --allow-empty commits.
 */
export function buildPrepareCommitMsgEmptyGuardHook(taskId: string): string {
  return `#!/bin/sh
set -eu
${PREPARE_COMMIT_MSG_HOOK_MARKER}
# fusion-task-id-seed: ${taskId}

# Only enforce in fusion-managed task worktrees.
TASK_FILE=$(git rev-parse --git-path fusion-task-id)
[ -f "$TASK_FILE" ] || exit 0

COMMIT_SOURCE="\${2:-}"

# Allow legitimate paths that may produce empty commits:
#   - commit  (amend via --amend with no -m)
#   - merge   (merge commit)
#   - squash  (squash merge)
#   - cherry-pick / revert / rebase ceremonies (detected via git-dir markers)
case "$COMMIT_SOURCE" in
  commit|merge|squash) exit 0 ;;
esac

# 'git commit --amend -m "..."' reports source=message (not commit), so the
# source arg alone cannot distinguish amend-with-new-message from
# --allow-empty -m. Inspect the parent process command line as a tiebreaker.
#
# Sourcing:
#   - 'ps -o args= -p $PPID' is POSIX (macOS, BSD, glibc Linux).
#   - Alpine/busybox 'ps' may not support '-o args='; fall back to
#     /proc/$PPID/cmdline (Linux including busybox).
#
# Matching: tokenize PARENT_CMD by whitespace and require an EXACT '--amend'
# token APPEARING BEFORE the first message-supplying flag ('-m', '-F',
# '--message', '--file', '--message=...', '--file=...'). 'ps -o args=' joins
# argv with spaces, so a commit message containing the substring '--amend'
# (e.g. -m 'fix --amend handling') re-tokenizes into a standalone '--amend'
# token — we must not be fooled by message content. Since '--amend' is a
# positional flag that always appears before the message args, stopping at
# the first message flag is reliable on both macOS ps and Linux
# /proc/$PPID/cmdline (which preserves argv boundaries with NUL separators).
PARENT_CMD=$(ps -o args= -p "$PPID" 2>/dev/null || echo "")
if [ -z "$PARENT_CMD" ] && [ -r "/proc/$PPID/cmdline" ]; then
  PARENT_CMD=$(tr '\0' ' ' < "/proc/$PPID/cmdline" 2>/dev/null || echo "")
fi
for tok in $PARENT_CMD; do
  case "$tok" in
    -m|-F|--message|--file|--message=*|--file=*)
      # Long-form message args; everything after this is user-controlled.
      break
      ;;
    -[!-]*[mF]*)
      # Combined short flag containing 'm' or 'F' (e.g. -am, -vm, -sm, -aF).
      # First char is '-', second is NOT '-' (so '--amend' does not match),
      # and the cluster contains a message-supplying letter. Everything after
      # this token is user-controlled message text.
      break
      ;;
    --amend)
      exit 0
      ;;
  esac
done

GIT_DIR=$(git rev-parse --git-dir)
if [ -f "$GIT_DIR/MERGE_HEAD" ] \\
  || [ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] \\
  || [ -f "$GIT_DIR/REVERT_HEAD" ] \\
  || [ -d "$GIT_DIR/rebase-merge" ] \\
  || [ -d "$GIT_DIR/rebase-apply" ]; then
  exit 0
fi

if git diff --cached --quiet --no-ext-diff 2>/dev/null; then
  printf '%s\\n' "fusion: refusing empty commit \u2014 staged diff is empty." >&2
  printf '%s\\n' "  Use fn_task_document_write for narrative output, not git commits." >&2
  printf '%s\\n' "  (FN-5345/FN-5377 empty-commit guard)" >&2
  exit 1
fi
`;
}

/*
FNXC:WorktreeHooks 2026-07-14-12:00:
options.taskPrefix is a fallback when taskId is not a well-formed "<PREFIX>-<n>" id. It is interpolated into the generated commit-msg hook's case arm and sed -E strip. Escape ERE metacharacters for sed and quote the case pattern via "$PREFIX" so a misconfigured prefix cannot break the hook or strip the wrong id (greptile P2 on PR #1930). Valid UI prefixes remain letter-led alphanumeric; escaping is defense-in-depth for the fallback path.
*/
function escapeSedEre(value: string): string {
  return value.replace(/[\\.^$*+?()[\]{}|]/g, "\\$&");
}

export function buildCommitMsgTrailerHook(
  taskId: string,
  options: {
    taskPrefix?: string;
    trailerName?: string;
    commitAuthorEnabled?: boolean;
    commitAuthorName?: string;
    commitAuthorEmail?: string;
  } = {}
): string {
  // Derive the strip prefix from the task id itself so per-mission prefixes
  // (e.g. ERR-5 while the project taskPrefix is still "FN") strip correctly.
  // The fusion-task-id file holds the real id, so PREFIX must match it, not the
  // project-wide options.taskPrefix. Falls back to options.taskPrefix / "FN"
  // only when taskId isn't a well-formed "<PREFIX>-<n>".
  const trimmedTaskId = taskId.trim();
  const derivedPrefix = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(trimmedTaskId)
    ? trimmedTaskId.replace(/-\d+$/, "").toUpperCase()
    : "";
  const taskPrefix = (derivedPrefix || options.taskPrefix || "FN").trim() || "FN";
  const taskPrefixSedEre = escapeSedEre(taskPrefix);
  const trailerName = (options.trailerName ?? "Fusion-Task-Id").trim() || "Fusion-Task-Id";
  const commitAuthorName = (options.commitAuthorName ?? DEFAULT_COMMIT_AUTHOR_NAME).trim() || DEFAULT_COMMIT_AUTHOR_NAME;
  const commitAuthorEmail = (options.commitAuthorEmail ?? DEFAULT_COMMIT_AUTHOR_EMAIL).trim() || DEFAULT_COMMIT_AUTHOR_EMAIL;
  const coAuthorInjection = options.commitAuthorEnabled === false
    ? ""
    : `

# FNXC:CommitAttribution 2026-06-26-12:40:
# Co-author attribution must be deterministic in the worktree hook, not dependent on an AI agent remembering a prompt-supplied git commit -m flag. addIfDifferent keeps an identical agent-added trailer from duplicating while preserving distinct human-provided co-authors.
CO_AUTHOR_TRAILER=${JSON.stringify(`Co-authored-by: ${commitAuthorName} <${commitAuthorEmail}>`)}
git interpret-trailers \\
  --in-place \\
  --if-exists addIfDifferent \\
  --trailer "$CO_AUTHOR_TRAILER" \\
  "$1"`;

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
  "$PREFIX"-*) ;;
  *) TASK_ID="$PREFIX-$(printf '%s' "$TASK_ID" | sed -E "s/^${taskPrefixSedEre}-//i")" ;;
esac

TRAILER_NAME=${JSON.stringify(trailerName)}

git interpret-trailers \
  --in-place \
  --if-exists doNothing \
  --trailer "$TRAILER_NAME: $TASK_ID" \
  "$1"${coAuthorInjection}
`;
}

export async function writeFileAtomic(targetPath: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(dirname(targetPath), { recursive: true });
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
  commitAuthorEnabled?: boolean;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
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
    commitAuthorEnabled: input.commitAuthorEnabled,
    commitAuthorName: input.commitAuthorName,
    commitAuthorEmail: input.commitAuthorEmail,
  });
  await writeFileAtomic(hookPath, hook, 0o755);
}

async function installPrepareCommitMsgEmptyGuard(input: {
  worktreePath: string;
  taskId: string;
}): Promise<void> {
  const hookPath = await resolveGitPath(input.worktreePath, "hooks/prepare-commit-msg");
  const existing = await fs.readFile(hookPath, "utf-8").catch(() => null);
  if (existing && !existing.includes(PREPARE_COMMIT_MSG_HOOK_MARKER)) {
    console.warn(
      `[worktree-hooks] prepare-commit-msg hook already exists at ${hookPath}; skipping Fusion empty-commit guard install for ${input.taskId}`
    );
    return;
  }

  const hook = buildPrepareCommitMsgEmptyGuardHook(input.taskId);
  await writeFileAtomic(hookPath, hook, 0o755);
}

export async function installTaskWorktreeIdentityGuard(input: {
  worktreePath: string;
  taskId: string;
  allowedBranchPatterns?: readonly string[];
  commitMsgHookEnabled?: boolean;
  taskPrefix?: string;
  taskAttributionTrailerName?: string;
  commitAuthorEnabled?: boolean;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
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
      commitAuthorEnabled: input.commitAuthorEnabled,
      commitAuthorName: input.commitAuthorName,
      commitAuthorEmail: input.commitAuthorEmail,
    });
  }

  // FN-5345/FN-5377: install the empty-commit guard alongside the trailer
  // hook. Skipped automatically if a non-fusion hook already exists.
  await installPrepareCommitMsgEmptyGuard({
    worktreePath: input.worktreePath,
    taskId: input.taskId,
  });
}
