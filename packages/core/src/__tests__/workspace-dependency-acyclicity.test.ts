import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  name: string;
  path: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
};

function getRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function readWorkspacePatterns(repoRoot: string): string[] {
  const workspaceConfig = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  return Array.from(workspaceConfig.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm), (match) => match[1]);
}

function expandWorkspacePattern(repoRoot: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    return [join(repoRoot, pattern)];
  }

  const marker = "/*";
  if (!pattern.endsWith(marker) || pattern.indexOf("*") !== pattern.length - 1) {
    throw new Error(`Unsupported pnpm workspace pattern in test: ${pattern}`);
  }

  const baseDir = join(repoRoot, pattern.slice(0, -marker.length));
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(baseDir, entry.name));
}

function loadWorkspacePackages(repoRoot: string): PackageManifest[] {
  const packageDirs = new Set<string>();
  for (const pattern of readWorkspacePatterns(repoRoot)) {
    for (const candidate of expandWorkspacePattern(repoRoot, pattern)) {
      const manifestPath = join(candidate, "package.json");
      if (existsSync(manifestPath)) {
        packageDirs.add(candidate);
      }
    }
  }

  return Array.from(packageDirs)
    .sort()
    .map((pkgPath) => {
      const manifest = JSON.parse(readFileSync(join(pkgPath, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };

      return {
        name: manifest.name,
        path: pkgPath,
        dependencies: manifest.dependencies ?? {},
        devDependencies: manifest.devDependencies ?? {},
        optionalDependencies: manifest.optionalDependencies ?? {},
      } satisfies PackageManifest;
    });
}

function collectWorkspaceEdges(packages: PackageManifest[]): Map<string, Set<string>> {
  const workspaceNames = new Set(packages.map((pkg) => pkg.name));
  const graph = new Map<string, Set<string>>();

  for (const pkg of packages) {
    const edges = new Set<string>();
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
      for (const depName of Object.keys(section)) {
        if (workspaceNames.has(depName)) {
          edges.add(depName);
        }
      }
    }
    graph.set(pkg.name, edges);
  }

  return graph;
}

function canonicalizeCycle(cycle: string[]): string {
  const nodes = cycle.slice(0, -1);
  const candidates = nodes.map((_, index) => {
    const rotated = [...nodes.slice(index), ...nodes.slice(0, index)];
    return [...rotated, rotated[0]].join(" -> ");
  });
  return candidates.sort()[0] ?? cycle.join(" -> ");
}

function findCycles(graph: Map<string, Set<string>>): string[] {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles = new Set<string>();

  function visit(node: string) {
    if (state.get(node) === "done") {
      return;
    }
    if (state.get(node) === "visiting") {
      return;
    }

    state.set(node, "visiting");
    stack.push(node);

    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "visiting") {
        const startIndex = stack.indexOf(next);
        const cycle = [...stack.slice(startIndex), next];
        cycles.add(canonicalizeCycle(cycle));
        continue;
      }
      visit(next);
    }

    stack.pop();
    state.set(node, "done");
  }

  for (const node of graph.keys()) {
    visit(node);
  }

  return Array.from(cycles).sort();
}

describe("workspace dependency graph", () => {
  it("stays acyclic across all workspace packages", () => {
    const packages = loadWorkspacePackages(getRepoRoot());
    const graph = collectWorkspaceEdges(packages);
    const cycles = findCycles(graph);

    expect(
      cycles,
      cycles.length === 0 ? "expected workspace dependency graph to be acyclic" : `workspace dependency cycles detected:\n${cycles.join("\n")}`,
    ).toEqual([]);
  });

  it("prevents dashboard-listed bundled plugins from depending on host packages", () => {
    const packages = loadWorkspacePackages(getRepoRoot());
    const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
    const dashboard = packageByName.get("@fusion/dashboard");

    expect(dashboard).toBeDefined();

    const bundledPluginNames = Object.keys(dashboard?.dependencies ?? {}).filter((name) => name.startsWith("@fusion-plugin-examples/"));
    const hostPackages = ["@fusion/dashboard", "@fusion/engine"];
    const offenders = bundledPluginNames.flatMap((pluginName) => {
      const plugin = packageByName.get(pluginName);
      if (!plugin) {
        return [];
      }

      return hostPackages
        .filter((hostName) => Object.prototype.hasOwnProperty.call(plugin.dependencies, hostName))
        .map((hostName) => `${pluginName} must not declare ${hostName} in dependencies`);
    });

    expect(
      offenders,
      offenders.length === 0
        ? "expected dashboard-listed bundled plugins to avoid host package runtime dependencies"
        : offenders.join("\n"),
    ).toEqual([]);
  });
});
