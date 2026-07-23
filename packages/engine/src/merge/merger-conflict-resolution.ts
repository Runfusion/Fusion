/**
 * FNXC:CodeOrganization 2026-07-15-14:30:
 * Auto conflict classification and resolution helpers peeled from merger.ts.
 */
import { promisify } from "node:util";
import { exec, execFile } from "node:child_process";
import { LOCKFILE_PATTERNS, GENERATED_PATTERNS, matchGlob, type ConflictType } from "./merger-glob.js";
import { mergerLog } from "../logger.js";

const execAsync = promisify(exec);
const execFileAsync: (file: string, args: string[], opts?: import("node:child_process").ExecFileOptions) => Promise<{ stdout: string; stderr: string }> = (file, args, opts) =>
  (promisify(execFile) as (f: string, a: string[], o?: object) => Promise<{ stdout: string; stderr: string }>)(file, args, opts);

export async function getConflictedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff --name-only --diff-filter=U", {
      cwd,
      encoding: "utf-8",
    });
    const output = stdout.trim();

    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a file has only trivial whitespace conflicts using git.
 * Compares ours (:2) and theirs (:3) versions with whitespace ignored.
 */
export async function isTrivialWhitespaceConflict(filePath: string, cwd: string): Promise<boolean> {
  try {
    /*
     * FNXC:MergeSafety 2026-07-15-13:25:
     * Conflict paths can originate in a repository checkout, so pass both stage
     * references as execFile arguments. `git diff` compares the index's ours
     * and theirs blobs directly; placing them after `--` would instead treat
     * them as pathspecs and silently fail to classify whitespace-only conflicts.
     */
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "-p", "-w", `:2:${filePath}`, `:3:${filePath}`],
      { cwd, encoding: "utf-8" },
    );

    // If the diff output is empty or contains no actual changes, it's trivial
    // The diff output will have headers but no +/- content lines for whitespace-only changes
    const lines = stdout.split("\n");
    const contentChanges = lines.filter(
      (line: string) => (line.startsWith("+") || line.startsWith("-")) &&
                !line.startsWith("+++") && !line.startsWith("---")
    );
    return contentChanges.length === 0;
  } catch (error: unknown) {
    // git diff may exit with code 1 when there are differences
    // Check if the error output indicates substantive changes
    const stdout = error && typeof error === "object" && "stdout" in error
      ? (error as { stdout?: unknown }).stdout
      : undefined;
    // Require non-empty stdout (matches prior monofile behavior: truthy stdout only)
    if (typeof stdout === "string" && stdout) {
      const lines = stdout.split("\n");
      const contentChanges = lines.filter(
        (line: string) => (line.startsWith("+") || line.startsWith("-")) &&
                  !line.startsWith("+++") && !line.startsWith("---")
      );
      return contentChanges.length === 0;
    }
    // On other errors, assume complex conflict (don't fallback to isTrivialConflict
    // which reads working directory files with conflict markers)
    return false;
  }
}

/**
 * Classify a single conflicted file for auto-resolution.
 * Returns one of: 'lockfile-ours', 'generated-theirs', 'trivial-whitespace', 'complex'
 */
export async function classifyConflict(filePath: string, cwd: string): Promise<ConflictType> {
  // Check for lock files - always take "ours" (current branch's version)
  if (LOCKFILE_PATTERNS.some((pattern) => matchGlob(filePath, pattern))) {
    return "lockfile-ours";
  }

  // Check for generated files - take "theirs" (keep branch's fresh generation)
  if (GENERATED_PATTERNS.some((pattern) => matchGlob(filePath, pattern))) {
    return "generated-theirs";
  }

  // Check for trivial conflicts (whitespace-only)
  if (await isTrivialWhitespaceConflict(filePath, cwd)) {
    return "trivial-whitespace";
  }

  // Complex conflicts require AI intervention
  return "complex";
}

/**
 * Resolve a conflicted file using "ours" (current branch's version).
 * Runs `git checkout --ours` and `git add`.
 */
export async function resolveWithOurs(filePath: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["checkout", "--ours", "--", filePath], { cwd });
    await execFileAsync("git", ["add", "--", filePath], { cwd });
    mergerLog.log(`Auto-resolved ${filePath} using --ours`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} with ours: ${error}`);
  }
}

/**
 * Resolve a conflicted file using "theirs" (incoming branch's version).
 * Runs `git checkout --theirs` and `git add`.
 */
export async function resolveWithTheirs(filePath: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["checkout", "--theirs", "--", filePath], { cwd });
    await execFileAsync("git", ["add", "--", filePath], { cwd });
    mergerLog.log(`Auto-resolved ${filePath} using --theirs`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} with theirs: ${error}`);
  }
}

/**
 * Resolve a trivial whitespace conflict.
 * For trivial conflicts, keep ours before staging the resolved file.
 */
export async function resolveTrivialWhitespace(filePath: string, cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["checkout", "--ours", "--", filePath], { cwd });
    await execFileAsync("git", ["add", "--", filePath], { cwd });
    mergerLog.log(`Auto-resolved ${filePath} (trivial whitespace)`);
  } catch (error) {
    throw new Error(`Failed to auto-resolve ${filePath} trivial conflict: ${error}`);
  }
}

// Legacy types re-exported for backward compatibility (tests may reference them)
/** @deprecated Use ConflictType instead */
export type ConflictResolution = "ours" | "theirs";

/** @deprecated Use classifyConflict + getConflictedFiles instead */
export interface ConflictCategory {
  filePath: string;
  autoResolvable: boolean;
  strategy?: ConflictResolution;
  reason: "lock-file" | "generated-file" | "trivial" | "complex";
}

/**
 * Detect and categorize merge conflicts. Delegates to the new classifyConflict API.
 * @deprecated Use getConflictedFiles() + classifyConflict() instead.
 */
export async function detectResolvableConflicts(rootDir: string): Promise<ConflictCategory[]> {
  const files = await getConflictedFiles(rootDir);
  const results: ConflictCategory[] = [];
  for (const filePath of files) {
    const type = await classifyConflict(filePath, rootDir);
    switch (type) {
      case "lockfile-ours":
        results.push({ filePath, autoResolvable: true, strategy: "ours", reason: "lock-file" });
        break;
      case "generated-theirs":
        results.push({ filePath, autoResolvable: true, strategy: "theirs", reason: "generated-file" });
        break;
      case "trivial-whitespace":
        results.push({ filePath, autoResolvable: true, strategy: "ours", reason: "trivial" });
        break;
      case "complex":
        results.push({ filePath, autoResolvable: false, reason: "complex" });
        break;
    }
  }
  return results;
}

/**
 * Auto-resolve a single file using git checkout --ours or --theirs.
 * @deprecated Use resolveWithOurs() or resolveWithTheirs() instead.
 */
export async function autoResolveFile(
  filePath: string,
  resolution: ConflictResolution,
  rootDir: string,
): Promise<void> {
  if (resolution === "ours") {
    await resolveWithOurs(filePath, rootDir);
  } else {
    await resolveWithTheirs(filePath, rootDir);
  }
}

/**
 * Auto-resolve all resolvable conflicts from the categorization.
 * @deprecated Use classifyConflict + resolveWithOurs/resolveWithTheirs instead.
 */
export async function resolveConflicts(
  categories: ConflictCategory[],
  rootDir: string,
): Promise<string[]> {
  const remainingComplex: string[] = [];
  for (const category of categories) {
    if (category.autoResolvable && category.strategy) {
      await autoResolveFile(category.filePath, category.strategy, rootDir);
    } else {
      remainingComplex.push(category.filePath);
    }
  }
  return remainingComplex;
}
