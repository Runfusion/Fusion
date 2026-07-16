/**
 * FNXC:CodeOrganization 2026-07-16-14:00:
 * Pure path/error/scope helpers peeled from self-healing.ts.
 */
import type { Task } from "@fusion/core";

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
