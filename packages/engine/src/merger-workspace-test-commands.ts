/**
 * FNXC:CodeOrganization 2026-07-15-12:00:
 * Workspace package mapping and default test command inference peeled from merger.ts.
 * Re-exported from merger.ts for stable public/test import paths.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { mergerLog } from "./logger.js";

/** Shell-safe single-argument quoting for command composition. */
function quoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Result of inferring a default test command */
export interface InferredTestCommand {
  command: string;
  /** Source indicates whether this was explicitly configured or inferred from project files */
  testSource: "explicit" | "inferred" | "inferred-scoped";
  buildSource?: "explicit" | "inferred";
}

/**
 * Parse a pnpm-workspace.yaml file and return the list of package glob patterns.
 * Handles only the `packages:` list format used in pnpm workspace configs.
 * Returns an empty array on any parse failure (best-effort).
 *
 * @internal Exported for testing only.
 */
export function parsePnpmWorkspaceGlobs(workspaceYamlContent: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of workspaceYamlContent.split("\n")) {
    const line = rawLine.trimEnd();
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      // A new top-level key ends the packages block
      if (/^\S/.test(line) && line.trim() !== "") {
        break;
      }
      // List item: "  - 'some/glob'" or `  - "some/glob"` or `  - some/glob`
      const match = line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?/);
      if (match && match[1]) {
        globs.push(match[1]);
      }
    }
  }
  return globs;
}

/**
 * Given a list of workspace package globs (e.g. "packages/*") and a rootDir,
 * return all package root directories (dirs that contain a package.json) that
 * match at least one glob.
 *
 * Glob matching: only simple single-star patterns at the last path segment are
 * supported (covering the `packages/*` and `plugins/examples/*` patterns used
 * in practice). Literal paths (no glob) are treated as direct package roots.
 *
 * @internal Exported for testing only.
 */
export function resolveWorkspacePackageRoots(
  rootDir: string,
  globs: string[],
): string[] {
  const roots: string[] = [];
  for (const glob of globs) {
    const starIdx = glob.indexOf("*");
    if (starIdx === -1) {
      // Literal path — treat the glob itself as a package root
      const candidate = join(rootDir, glob);
      if (existsSync(join(candidate, "package.json"))) {
        roots.push(glob); // Store relative to rootDir
      }
      continue;
    }
    // Pattern like "packages/*" or "plugins/examples/*"
    // The prefix is everything before the last slash before the star
    const prefix = glob.slice(0, starIdx);
    const parentDir = join(rootDir, prefix.replace(/\/$/, ""));
    let entries: string[];
    try {
      entries = readdirSync(parentDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relPath = `${prefix.replace(/\/$/, "")}/${entry}`;
      const absPath = join(rootDir, relPath);
      if (existsSync(join(absPath, "package.json"))) {
        roots.push(relPath); // Store relative to rootDir
      }
    }
  }
  return roots;
}

/**
 * Given a list of changed files (relative to rootDir) and a list of package
 * root paths (relative to rootDir), return the unique package names (from each
 * package.json's "name" field) whose root is the longest prefix-match for at
 * least one changed file.
 *
 * @internal Exported for testing only.
 */
export function mapChangedFilesToPackageNames(
  changedFiles: string[],
  packageRoots: string[],
  rootDir: string,
): string[] {
  const nameSet = new Set<string>();
  for (const file of changedFiles) {
    // Find the longest package root that is a prefix of this file
    let bestRoot: string | null = null;
    let bestLen = -1;
    for (const pkgRoot of packageRoots) {
      const prefix = pkgRoot.endsWith("/") ? pkgRoot : `${pkgRoot}/`;
      if (file === pkgRoot || file.startsWith(prefix)) {
        if (pkgRoot.length > bestLen) {
          bestLen = pkgRoot.length;
          bestRoot = pkgRoot;
        }
      }
    }
    if (bestRoot !== null) {
      // Read the package name from package.json
      try {
        const pkgJsonPath = join(rootDir, bestRoot, "package.json");
        const raw = readFileSync(pkgJsonPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: string };
        if (parsed.name) {
          nameSet.add(parsed.name);
        }
      } catch {
        // If we can't read the package name, use the relative root path
        nameSet.add(bestRoot);
      }
    }
  }
  return Array.from(nameSet);
}

/**
 * Best-effort: map a list of repo-relative file paths to the pnpm package
 * names they belong to. Returns an empty array if pnpm-workspace.yaml is
 * missing or unparseable — callers fall back to a directory-based heuristic.
 *
 * @internal Exported for testing only.
 */
export function packageNamesForFiles(rootDir: string, files: string[]): string[] {
  if (files.length === 0) return [];
  let workspaceContent: string;
  try {
    workspaceContent = readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf-8");
  } catch {
    return [];
  }
  const globs = parsePnpmWorkspaceGlobs(workspaceContent);
  if (globs.length === 0) return [];
  const packageRoots = resolveWorkspacePackageRoots(rootDir, globs);
  if (packageRoots.length === 0) return [];
  return mapChangedFilesToPackageNames(files, packageRoots, rootDir);
}

/**
 * Attempt to derive the set of pnpm package names touched by the branch.
 * Returns null when scoping cannot be determined (missing git context, no
 * workspace file, root-only changes, etc.) — callers fall back to `pnpm test`.
 *
 * @internal Exported for testing only.
 */
export function deriveScopedPnpmTestCommand(rootDir: string, baseBranch: string, branch: string): string | null {
  // 1. Read and parse pnpm-workspace.yaml
  const workspacePath = join(rootDir, "pnpm-workspace.yaml");
  let workspaceContent: string;
  try {
    workspaceContent = readFileSync(workspacePath, "utf-8");
  } catch {
    return null;
  }
  const globs = parsePnpmWorkspaceGlobs(workspaceContent);
  if (globs.length === 0) return null;

  // 2. Resolve actual package roots
  const packageRoots = resolveWorkspacePackageRoots(rootDir, globs);
  if (packageRoots.length === 0) return null;

  // 3. Get the changed files between base and the branch tip passed by caller.
  let changedFilesOutput: string;
  try {
    changedFilesOutput = execSync(
      `git diff --name-only ${quoteArg(baseBranch)}...${quoteArg(branch)}`,
      { cwd: rootDir, stdio: "pipe", encoding: "utf-8" },
    ).toString();
  } catch {
    return null;
  }
  const changedFiles = changedFilesOutput
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  if (changedFiles.length === 0) return null;

  // 4. Map changed files to package names
  const packageNames = mapChangedFilesToPackageNames(changedFiles, packageRoots, rootDir);
  if (packageNames.length === 0) {
    // All changes are at the root (e.g. workspace config) — fall back to full suite
    return null;
  }

  // 5. Compose the scoped pnpm command
  // `...^` includes dependents (packages that import the changed packages).
  // Package names come from workspace package.json files (potentially
  // untrusted) so we quote each filter argument via `quoteArg` to prevent
  // shell interpolation if a name contains metacharacters.
  const filters = packageNames.map((name) => `--filter ${quoteArg(`${name}...^`)}`).join(" ");
  return `pnpm ${filters} test`;
}

/**
 * Matches a Vitest/Jest-style test or spec file by extension.
 * @internal
 */
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

/**
 * Derive a verification command that runs ONLY the test files implicated by the
 * branch diff, so merge verification scales with the change instead of the
 * repository.
 *
 * For each file changed between `baseBranch` and `branch`:
 *  - A changed test/spec file (`*.test.ts` / `*.spec.tsx` / …) is run directly.
 *  - A changed source file resolves to its co-located test, if one exists on
 *    disk: `<dir>/__tests__/<name>.test.{ts,tsx}` or the sibling
 *    `<dir>/<name>.test.{ts,tsx}`.
 * Resolved test files are grouped by their owning pnpm workspace package and run
 * via `pnpm --filter <pkg> exec vitest run <relPaths…> --silent=passed-only
 * --reporter=dot`. Multiple packages are joined with ` && `.
 *
 * Returns `null` when scoping can't be established (no workspace, no git
 * context, or — importantly — when NO test files resolve from the diff). The
 * caller treats `null` as "fall back to the broader command".
 *
 * FNXC:Verification 2026-06-25-00:00:
 * Merge/executor verification must complete in seconds-to-<2min by running only
 * the diff's own tests, not a whole-package or full-suite command. This relies
 * on the thin, trusted merge gate (`pnpm test:gate`) to carry cross-cutting
 * coverage; per-branch verification only needs to prove the branch's own tests
 * still pass. When a diff touches source with no co-located test (or only
 * non-source files), file-scoping yields nothing and we deliberately return
 * null so the caller falls back to the existing package-scoped/explicit command
 * rather than verifying nothing. Package names come from workspace package.json
 * files and test paths come from `git diff`, so every shell argument is quoted
 * via `quoteArg`.
 *
 * @internal Exported for testing only.
 */
export function deriveFileScopedPnpmTestCommand(
  rootDir: string,
  baseBranch: string,
  branch: string,
): string | null {
  // 1. Read and parse pnpm-workspace.yaml + resolve package roots.
  let workspaceContent: string;
  try {
    workspaceContent = readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf-8");
  } catch {
    return null;
  }
  const globs = parsePnpmWorkspaceGlobs(workspaceContent);
  if (globs.length === 0) return null;
  const packageRoots = resolveWorkspacePackageRoots(rootDir, globs);
  if (packageRoots.length === 0) return null;

  // 2. Get the changed files between base and the branch tip.
  let changedFilesOutput: string;
  try {
    changedFilesOutput = execSync(
      `git diff --name-only ${quoteArg(baseBranch)}...${quoteArg(branch)}`,
      { cwd: rootDir, stdio: "pipe", encoding: "utf-8" },
    ).toString();
  } catch {
    return null;
  }
  const changedFiles = changedFilesOutput
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  if (changedFiles.length === 0) return null;

  // 3. Resolve a set of repo-relative test files from the diff.
  const resolvedTests = new Set<string>();
  for (const file of changedFiles) {
    if (TEST_FILE_RE.test(file)) {
      // A changed test/spec file is run directly.
      resolvedTests.add(file);
      continue;
    }
    // A changed source file maps to a co-located test if one exists on disk.
    const dir = dirname(file);
    const stem = basename(file).replace(/\.(ts|tsx|js|jsx)$/, "");
    if (!stem) continue;
    const candidates = [
      `${dir}/__tests__/${stem}.test.ts`,
      `${dir}/__tests__/${stem}.test.tsx`,
      `${dir}/${stem}.test.ts`,
      `${dir}/${stem}.test.tsx`,
    ];
    for (const candidate of candidates) {
      // dirname("foo.ts") === "." → normalize the leading "./".
      const normalized = candidate.startsWith("./") ? candidate.slice(2) : candidate;
      if (existsSync(join(rootDir, normalized))) {
        resolvedTests.add(normalized);
      }
    }
  }
  if (resolvedTests.size === 0) return null;

  // 4. Group resolved test files by their owning workspace package.
  const byPackage = new Map<string, { name: string; tests: Set<string> }>();
  for (const testFile of resolvedTests) {
    // Find the longest package root that is a prefix of this test file.
    let bestRoot: string | null = null;
    let bestLen = -1;
    for (const pkgRoot of packageRoots) {
      const prefix = pkgRoot.endsWith("/") ? pkgRoot : `${pkgRoot}/`;
      if (testFile === pkgRoot || testFile.startsWith(prefix)) {
        if (pkgRoot.length > bestLen) {
          bestLen = pkgRoot.length;
          bestRoot = pkgRoot;
        }
      }
    }
    if (bestRoot === null) continue;
    const relPath = testFile.slice(bestRoot.length + 1);
    if (!relPath) continue;
    // Defensively skip any path quoting can't safely contain.
    if (relPath.includes("\n") || relPath.includes("\0")) continue;
    let entry = byPackage.get(bestRoot);
    if (!entry) {
      // Read the package name from package.json (fall back to the root path).
      let name = bestRoot;
      try {
        const parsed = JSON.parse(
          readFileSync(join(rootDir, bestRoot, "package.json"), "utf-8"),
        ) as { name?: string };
        if (parsed.name) name = parsed.name;
      } catch {
        // keep the relative root path as the filter
      }
      entry = { name, tests: new Set<string>() };
      byPackage.set(bestRoot, entry);
    }
    entry.tests.add(relPath);
  }
  if (byPackage.size === 0) return null;

  // 5. Compose one scoped vitest invocation per package, joined with ` && `.
  const segments: string[] = [];
  for (const root of Array.from(byPackage.keys()).sort()) {
    const entry = byPackage.get(root);
    if (!entry) continue;
    const quotedPaths = Array.from(entry.tests)
      .sort()
      .map((p) => quoteArg(p));
    if (quotedPaths.length === 0) continue;
    segments.push(
      `pnpm --filter ${quoteArg(entry.name)} exec vitest run ${quotedPaths.join(" ")} --silent=passed-only --reporter=dot`,
    );
  }
  if (segments.length === 0) return null;
  return segments.join(" && ");
}

/**
 * Infer a default test command based on project files.
 * Returns the command and whether it was explicitly configured or inferred.
 *
 * Inference rules:
 * - pnpm-lock.yaml → "pnpm test" (or scoped when monorepo + git context available)
 * - yarn.lock → "yarn test"
 * - bun.lock/bun.lockb → "bun test"
 * - package-lock.json → "npm test"
 *
 * When a pnpm workspace is detected and git context (baseBranch + branch) is
 * provided, the command is automatically scoped to the packages touched by the
 * branch diff. testSource will be "inferred-scoped" in that case.
 *
 * FNXC:Verification 2026-06-25-00:00:
 * When `scopeToChangedFiles` is true (project setting
 * `scopeVerificationToChangedFiles`, default true) AND git context is present,
 * verification is first narrowed to the diff's own test FILES via
 * `deriveFileScopedPnpmTestCommand` — for BOTH explicit and inferred commands,
 * so even a configured whole-package `testCommand` gets file-scoped. This keeps
 * per-branch verification proportional to the change; cross-cutting coverage is
 * owned by the thin merge gate. If file-scoping yields nothing (no resolvable
 * tests) or the setting is off, the original behavior is preserved exactly:
 * explicit command as-is, else package-scoped inference, else unscoped fallback.
 *
 * Returns null if no test command can be inferred.
 */
export function inferDefaultTestCommand(
  rootDir: string,
  explicitTestCommand?: string,
  explicitBuildCommand?: string,
  baseBranch?: string,
  branch?: string,
  scopeToChangedFiles?: boolean,
): InferredTestCommand | null {
  // File-scoped verification: try first for BOTH explicit and inferred cases.
  // Only narrows when the setting is on, git context exists, and at least one
  // test file resolves from the diff; otherwise falls through to existing logic.
  if (scopeToChangedFiles && baseBranch?.trim() && branch?.trim()) {
    try {
      const fileScoped = deriveFileScopedPnpmTestCommand(rootDir, baseBranch.trim(), branch.trim());
      if (fileScoped) {
        mergerLog.log(`Scoped verification to changed test files: ${fileScoped}`);
        const fileScopedBuildSource = explicitBuildCommand?.trim() ? "explicit" : undefined;
        return { command: fileScoped, testSource: "inferred-scoped", buildSource: fileScopedBuildSource };
      }
    } catch {
      // Fall through to existing explicit/inferred behavior.
    }
  }

  // If explicit test command is set, use it (no inference needed)
  if (explicitTestCommand?.trim()) {
    return {
      command: explicitTestCommand.trim(),
      testSource: "explicit",
      buildSource: explicitBuildCommand?.trim() ? "explicit" : undefined,
    };
  }

  const buildSource = explicitBuildCommand?.trim() ? "explicit" : undefined;

  // Infer test command from lock files
  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) {
    // Monorepo heuristic: if pnpm-workspace.yaml exists and we have git context,
    // scope the command to only the packages touched by this branch's diff.
    if (existsSync(join(rootDir, "pnpm-workspace.yaml"))) {
      if (baseBranch?.trim() && branch?.trim()) {
        try {
          const scoped = deriveScopedPnpmTestCommand(rootDir, baseBranch.trim(), branch.trim());
          if (scoped) {
            mergerLog.log(
              `Scoped inferred test command to changed packages: ${scoped}`,
            );
            return { command: scoped, testSource: "inferred-scoped", buildSource };
          }
        } catch {
          // Fall through to unscoped fallback
        }
      }
      // No git context or scoping failed — warn and use unscoped
      mergerLog.warn(
        `Inferred test command "pnpm test" in a pnpm workspace (${rootDir}). ` +
        `This runs the full monorepo suite on every merge. Consider setting an explicit ` +
        `scoped testCommand in project settings, e.g. \`pnpm -r --filter "...[main]" test\`.`,
      );
    }
    return { command: "pnpm test", testSource: "inferred", buildSource };
  }

  if (existsSync(join(rootDir, "yarn.lock"))) {
    return { command: "yarn test", testSource: "inferred", buildSource };
  }

  if (existsSync(join(rootDir, "bun.lock")) || existsSync(join(rootDir, "bun.lockb"))) {
    return { command: "bun test", testSource: "inferred", buildSource };
  }

  if (existsSync(join(rootDir, "package-lock.json"))) {
    return { command: "npm test", testSource: "inferred", buildSource };
  }

  // No inference possible — return null, letting the caller decide what to do
  return null;
}
