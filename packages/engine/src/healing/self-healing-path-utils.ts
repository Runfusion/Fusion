/**
 * FNXC:CodeOrganization 2026-07-16-14:00:
 * Pure path/error/scope helpers peeled from self-healing.ts.
 */
import {
  isTaskNotFoundError as isCoreTaskNotFoundError,
  TaskDeletedError,
  type Task,
  type TaskStore,
} from "@fusion/core";

export function extractTaskIdFromTempMergeDir(dirname: string): string | null {
  const match = /^fusion-ai-merge-(fn-\d+)-[a-z0-9]+$/i.exec(dirname);
  return match?.[1]?.toUpperCase() ?? null;
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isTaskNotFoundError(err: unknown): boolean {
  return /\btask\s+fn-\d+\s+not found\b/i.test(getErrorMessage(err));
}

/*
FNXC:SelfHealing 2026-08-10-09:51:
Runfusion/Fusion#3397 requires durable-agent link recovery to treat PostgreSQL
`getTask` misses as ordinary stale-link input. The older FN-only regex above
must remain unchanged for temp-merge paths, because production ids also include
`ERR-024` and other prefixes. Archive snapshots are resolved tasks in a
terminal column, never misses, so this guard only normalizes thrown lookup
errors and not successful task reads.
*/
export function isMissingTaskLookupError(err: unknown): boolean {
  if (isCoreTaskNotFoundError(err) || err instanceof TaskDeletedError) return true;
  if (err && typeof err === "object" && (err as { name?: unknown }).name === "TaskDeletedError") return true;
  return err instanceof Error && /\btask\s+\S+\s+not found\b/i.test(err.message);
}

export async function readLinkedTaskOrUndefined(
  store: Pick<TaskStore, "getTask">,
  taskId: string,
): Promise<Task | undefined> {
  try {
    return (await store.getTask(taskId)) ?? undefined;
  } catch (err) {
    if (isMissingTaskLookupError(err)) return undefined;
    throw err;
  }
}

export function buildResumeLimboStepSignature(task: Task): string {
  return JSON.stringify({
    currentStep: task.currentStep ?? null,
    steps: Array.isArray(task.steps) ? task.steps.map((step) => step.status) : [],
  });
}

export function formatRecoveryTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export function matchGlob(path: string, pattern: string): boolean {
  if (pattern.includes("**")) {
    const regexPattern = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<DOUBLESTAR>>>/g, ".*");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  }

  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash !== -1) {
    const patternDir = pattern.slice(0, lastSlash);
    const patternFile = pattern.slice(lastSlash + 1);
    const pathDir = path.lastIndexOf("/") !== -1 ? path.slice(0, path.lastIndexOf("/")) : "";
    const pathFile = path.lastIndexOf("/") !== -1 ? path.slice(path.lastIndexOf("/")) : path;

    if (patternDir.includes("*")) {
      const dirRegex = new RegExp(`^${patternDir.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`);
      if (!dirRegex.test(pathDir)) return false;
    } else if (!pathDir.endsWith(patternDir) && patternDir !== pathDir) {
      return false;
    }

    return matchGlob(pathFile, patternFile);
  }

  const fileName = path.lastIndexOf("/") !== -1 ? path.slice(path.lastIndexOf("/") + 1) : path;
  const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, "[^/]*");
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(fileName) || regex.test(path);
}

export function matchesScope(filePath: string, scopePatterns: string[]): boolean {
  for (const pattern of scopePatterns) {
    if (matchGlob(filePath, pattern)) return true;
    const dirPattern = pattern.replace(/\/\*+$/, "");
    if (dirPattern !== pattern && filePath.startsWith(dirPattern + "/")) return true;
    if (pattern.endsWith("/") && filePath.startsWith(pattern)) return true;
    const patternDir = pattern.lastIndexOf("/") >= 0 ? pattern.slice(0, pattern.lastIndexOf("/")) : "";
    const fileDir = filePath.lastIndexOf("/") >= 0 ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    if (patternDir && fileDir === patternDir) return true;
  }
  return false;
}
