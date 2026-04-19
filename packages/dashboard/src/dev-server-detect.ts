import { glob, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** Script names in priority order (most likely first) */
export const DEV_SCRIPT_NAMES = ["dev", "start", "web", "frontend", "serve", "storybook", "preview"] as const;

/** Framework indicators in devDependencies/dependencies */
export const FRAMEWORK_INDICATORS = [
  "vite", "next", "nuxt", "@angular/cli", "react-scripts",
  "webpack-dev-server", "@storybook/react", "parcel",
  "astro", "svelte", "remix", "@remix-run/dev",
  "@sveltejs/kit", "gatsby", "haul",
];

export interface DetectedScript {
  /** Script name (e.g., "dev") */
  name: string;
  /** Full command string (e.g., "vite") */
  command: string;
  /** Source path: "root" for project root, relative path for workspace packages */
  source: string;
  /** Package name from package.json "name" field */
  packageName?: string;
  /** Confidence score 0-1 based on script name priority and framework detection */
  confidence: number;
}

export interface DetectionResult {
  candidates: DetectedScript[];
}

interface PackageJsonShape {
  name?: string;
  main?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(filePath: string): Promise<PackageJsonShape | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return null;
  }
}

function getScriptPriorityScore(scriptName: string): number {
  const index = DEV_SCRIPT_NAMES.indexOf(scriptName as (typeof DEV_SCRIPT_NAMES)[number]);
  if (index === -1) {
    return 0;
  }

  if (DEV_SCRIPT_NAMES.length <= 1) {
    return 0.5;
  }

  const maxBoost = 0.5;
  const minBoost = 0.2;
  const delta = maxBoost - minBoost;
  const ratio = index / (DEV_SCRIPT_NAMES.length - 1);
  return maxBoost - (ratio * delta);
}

function hasFrameworkIndicator(pkg: PackageJsonShape): boolean {
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  return FRAMEWORK_INDICATORS.some((indicator) => indicator in deps);
}

function scoreCandidate(scriptName: string, pkg: PackageJsonShape): number {
  let score = getScriptPriorityScore(scriptName);

  if (hasFrameworkIndicator(pkg)) {
    score += 0.3;
  }

  if (pkg.private === true || !pkg.main) {
    score += 0.2;
  }

  return Math.min(1, score);
}

async function collectWorkspacePackageJsons(projectRoot: string): Promise<string[]> {
  const discovered = new Set<string>();

  try {
    await readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf-8");
  } catch {
    // Missing pnpm workspace file is okay.
  }

  for (const pattern of ["packages/*/package.json", "apps/*/package.json"]) {
    try {
      for await (const match of glob(pattern, { cwd: projectRoot })) {
        if (typeof match === "string") {
          discovered.add(resolve(projectRoot, match));
        }
      }
    } catch {
      // Invalid glob or inaccessible directory; skip.
    }
  }

  return [...discovered];
}

function extractScripts(pkg: PackageJsonShape): Array<{ name: string; command: string }> {
  const scripts = pkg.scripts ?? {};
  const output: Array<{ name: string; command: string }> = [];

  for (const scriptName of DEV_SCRIPT_NAMES) {
    const command = scripts[scriptName];
    if (typeof command === "string" && command.trim().length > 0) {
      output.push({ name: scriptName, command: command.trim() });
    }
  }

  return output;
}

function toSource(projectRoot: string, packageJsonPath: string): string {
  const packageDir = dirname(packageJsonPath);
  const rel = relative(projectRoot, packageDir).replace(/\\/g, "/");
  return rel.length > 0 ? rel : "root";
}

export async function detectDevServerScripts(projectRoot: string): Promise<DetectionResult> {
  const root = resolve(projectRoot);
  const candidates: DetectedScript[] = [];

  const rootPackagePath = join(root, "package.json");
  const rootPackage = await readPackageJson(rootPackagePath);

  if (rootPackage) {
    for (const script of extractScripts(rootPackage)) {
      candidates.push({
        name: script.name,
        command: script.command,
        source: "root",
        packageName: rootPackage.name,
        confidence: scoreCandidate(script.name, rootPackage),
      });
    }
  }

  const workspacePackageJsons = await collectWorkspacePackageJsons(root);
  for (const packageJsonPath of workspacePackageJsons) {
    const pkg = await readPackageJson(packageJsonPath);
    if (!pkg) {
      continue;
    }

    for (const script of extractScripts(pkg)) {
      candidates.push({
        name: script.name,
        command: script.command,
        source: toSource(root, packageJsonPath),
        packageName: pkg.name,
        confidence: scoreCandidate(script.name, pkg),
      });
    }
  }

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }

    if (a.source !== b.source) {
      return a.source.localeCompare(b.source);
    }

    return a.name.localeCompare(b.name);
  });

  return { candidates };
}
