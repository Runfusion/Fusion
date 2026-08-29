import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QualityPresetId } from "../store/quality-types.js";

/*
FNXC:Quality 2026-07-14-21:45:
Allowlisted preset id → command mapping. Server resolves only; clients never supply command/argv/cwd.
full-suite requires explicit confirmFullSuite. file-scoped builds from server-side path list.
*/

export const QUALITY_PRESET_IDS: readonly QualityPresetId[] = [
  "project-test",
  "test-gate",
  "verify-fast",
  "file-scoped",
  "full-suite",
] as const;

export function isQualityPresetId(value: unknown): value is QualityPresetId {
  return typeof value === "string" && (QUALITY_PRESET_IDS as readonly string[]).includes(value);
}

export interface ResolvePresetInput {
  preset: QualityPresetId;
  /** Project settings.testCommand when set */
  testCommand?: string | null;
  /** Absolute project root */
  projectRoot: string;
  /** Execution cwd for the run; defaults to projectRoot. */
  cwd?: string;
  /** File paths relative to project/worktree for file-scoped preset */
  filePaths?: string[];
  confirmFullSuite?: boolean;
}

export type ResolvePresetResult =
  | { ok: true; command: string; label: string }
  | { ok: false; reason: string; code: "unknown_preset" | "disabled" | "confirm_required" | "empty_files" };

/**
 * Reject path tokens that could escape the worktree or inject shell metacharacters.
 */
export function isSafeFilePathToken(path: string): boolean {
  if (!path || typeof path !== "string") return false;
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) return false;
  if (path.startsWith("/") || path.includes("..")) return false;
  // Disallow shell metacharacters when paths are joined into a shell command string.
  if (/[;&|`$<>\\]/.test(path)) return false;
  return true;
}

/** Shell-safe single-argument quoting for commands evaluated by the runner shell. */
function quoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseWorkspaceGlobs(workspaceYaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of workspaceYaml.split("\n")) {
    const line = rawLine.trimEnd();
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line) && line.trim() !== "") break;
    const match = line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?/);
    if (match?.[1]) globs.push(match[1]);
  }
  return globs;
}

function resolveWorkspacePackageRoots(rootDir: string, globs: string[]): string[] {
  const roots = new Set<string>();
  for (const glob of globs) {
    const starIndex = glob.indexOf("*");
    if (starIndex === -1) {
      if (existsSync(join(rootDir, glob, "package.json"))) roots.add(glob);
      continue;
    }
    const prefix = glob.slice(0, starIndex).replace(/\/$/, "");
    let entries: string[];
    try {
      entries = readdirSync(join(rootDir, prefix), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const packageRoot = `${prefix}/${entry}`;
      if (existsSync(join(rootDir, packageRoot, "package.json"))) roots.add(packageRoot);
    }
  }
  return [...roots];
}

function groupPathsByWorkspacePackage(
  rootDir: string,
  paths: string[],
): Array<{ root: string; name: string; paths: string[] }> {
  let workspaceYaml: string;
  try {
    workspaceYaml = readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const packageRoots = resolveWorkspacePackageRoots(rootDir, parseWorkspaceGlobs(workspaceYaml));
  const groups = new Map<string, { name: string; paths: Set<string> }>();
  for (const path of paths) {
    let matchedRoot: string | undefined;
    for (const packageRoot of packageRoots) {
      if (path.startsWith(`${packageRoot}/`) && (!matchedRoot || packageRoot.length > matchedRoot.length)) {
        matchedRoot = packageRoot;
      }
    }
    if (!matchedRoot) continue;
    let group = groups.get(matchedRoot);
    if (!group) {
      try {
        const parsed = JSON.parse(readFileSync(join(rootDir, matchedRoot, "package.json"), "utf8")) as {
          name?: unknown;
        };
        if (typeof parsed.name !== "string" || !parsed.name) continue;
        group = { name: parsed.name, paths: new Set<string>() };
        groups.set(matchedRoot, group);
      } catch {
        continue;
      }
    }
    group.paths.add(path.slice(matchedRoot.length + 1));
  }
  return [...groups.entries()]
    .map(([root, group]) => ({ root, name: group.name, paths: [...group.paths].sort() }))
    .filter((group) => group.paths.length > 0)
    .sort((left, right) => left.root.localeCompare(right.root));
}

/*
FNXC:Quality 2026-08-13-22:28:
Quality file-scoped commands must invoke each package-local Vitest binary because the workspace root has no Vitest dependency. Resolve package ownership against the execution cwd because task runs execute in live or disposable QA worktrees, and emit no reporter flag because Vitest 4 removed basic and its default reporter is correct here. This boundary applies only to commands emitted below: configured --reporter=dot usage in engine merger commands, scripts, and package tests remains valid and intentionally untouched.
*/
function buildFileScopedCommand(resolutionRoot: string, paths: string[]): string {
  const groups = groupPathsByWorkspacePackage(resolutionRoot, paths);
  if (groups.length === 0) {
    return `pnpm exec vitest run ${paths.map(quoteArg).join(" ")}`;
  }
  return groups
    .map(
      (group) =>
        `pnpm --filter ${quoteArg(group.name)} exec vitest run ${group.paths.map(quoteArg).join(" ")}`,
    )
    .join(" && ");
}

export function resolvePresetCommand(input: ResolvePresetInput): ResolvePresetResult {
  switch (input.preset) {
    case "project-test": {
      const cmd = (input.testCommand ?? "").trim();
      if (!cmd) {
        return {
          ok: false,
          reason: "Project testCommand is not configured",
          code: "disabled",
        };
      }
      return { ok: true, command: cmd, label: "Project test" };
    }
    case "test-gate":
      return { ok: true, command: "pnpm test:gate", label: "Merge gate tests" };
    case "verify-fast":
      return { ok: true, command: "pnpm verify:fast", label: "Verify fast (test-free)" };
    case "file-scoped": {
      const paths = (input.filePaths ?? []).map((p) => p.trim()).filter(Boolean);
      if (paths.length === 0) {
        return { ok: false, reason: "No changed files for file-scoped run", code: "empty_files" };
      }
      const safe = [...new Set(paths.filter(isSafeFilePathToken))].sort();
      if (safe.length === 0) {
        return { ok: false, reason: "No safe file paths for file-scoped run", code: "empty_files" };
      }
      return {
        ok: true,
        command: buildFileScopedCommand(input.cwd ?? input.projectRoot, safe),
        label: "File-scoped tests",
      };
    }
    case "full-suite": {
      if (!input.confirmFullSuite) {
        return {
          ok: false,
          reason: "full-suite requires confirmFullSuite: true",
          code: "confirm_required",
        };
      }
      return { ok: true, command: "pnpm test:full", label: "Full suite (opt-in)" };
    }
    default:
      return { ok: false, reason: "Unknown preset", code: "unknown_preset" };
  }
}

export function listPresetCatalog(): Array<{ id: QualityPresetId; label: string; needsConfirm?: boolean }> {
  return [
    { id: "project-test", label: "Project test" },
    { id: "test-gate", label: "Merge gate (test:gate)" },
    { id: "verify-fast", label: "Verify fast" },
    { id: "file-scoped", label: "File-scoped" },
    { id: "full-suite", label: "Full suite", needsConfirm: true },
  ];
}
