import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { normalizeRelPath } from "./graph-types.js";

export const DEFAULT_EXCLUDED_DIRECTORIES = ["node_modules", "dist", "dist-electron", "coverage", ".git", ".fusion", ".fusion-knowledge", ".worktrees", ".pi", ".history", ".gate-bundle", "build", "android", "public", "locales"];
export const DEFAULT_SOURCE_ROOTS = ["packages/*/src", "packages/dashboard/app", "packages/*/scripts", "scripts", "plugins"];
export const DEFAULT_MARKDOWN_ROOTS = ["docs", "AGENTS.md", "CONCEPTS.md"];
const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js"]);
const markdownExtensions = new Set([".md"]);

/*
FNXC:KnowledgeGraph 2026-08-10-11:15:
Discovery is rooted in the explicit source-root contract rather than the repository root. The
Dashboard keeps first-party React source in packages/dashboard/app, outside src; omitting it would
silently lose that component and FNXC-rationale surface from the deterministic graph.
*/
export interface FileDiscoveryOptions {
  excludedDirectories?: string[];
  sourceRoots?: string[];
  markdownRoots?: string[];
}

async function existingDirectories(root: string, patterns: readonly string[]): Promise<string[]> {
  const results = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      try { if ((await stat(join(root, pattern))).isDirectory()) results.add(join(root, pattern)); } catch { /* Optional roots are absent in small fixture repositories. */ }
      continue;
    }
    const [prefix, suffix] = pattern.split("*");
    const container = join(root, prefix ?? "");
    try {
      for (const entry of await readdir(container, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(container, entry.name, suffix ?? "");
        try { if ((await stat(candidate)).isDirectory()) results.add(candidate); } catch { /* Pattern entry has no matching child root. */ }
      }
    } catch { /* Optional root container is absent. */ }
  }
  return [...results].sort();
}

async function packageEntryFiles(root: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for (const pkg of await readdir(join(root, "packages"), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const packageRoot = join(root, "packages", pkg.name);
      for (const name of await readdir(packageRoot)) {
        if (name === "index.ts" || name === "bin.mjs" || name === "build.ts" || name.endsWith(".config.ts")) {
          const candidate = join(packageRoot, name);
          try { if ((await stat(candidate)).isFile()) entries.push(candidate); } catch { /* Directory entries can race a fixture mutation. */ }
        }
      }
    }
  } catch { /* A fixture may intentionally omit packages. */ }
  return entries.sort();
}

/** Deterministically discover only the documented graph inputs, never generated or unrelated files. */
export async function discoverFiles(root: string, options: FileDiscoveryOptions = {}): Promise<string[]> {
  const excluded = new Set(options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const output = new Set<string>();
  const add = (absolute: string) => output.add(normalizeRelPath(relative(root, absolute)));
  const walk = async (absolute: string, allowedExtensions: Set<string>): Promise<void> => {
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await walk(candidate, allowedExtensions);
      } else if (entry.isFile() && allowedExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) && !entry.name.endsWith(".d.ts")) {
        add(candidate);
      }
    }
  };

  for (const directory of await existingDirectories(root, options.sourceRoots ?? DEFAULT_SOURCE_ROOTS)) await walk(directory, sourceExtensions);
  for (const directory of await existingDirectories(root, options.markdownRoots ?? DEFAULT_MARKDOWN_ROOTS.filter(path => path === "docs"))) await walk(directory, markdownExtensions);
  for (const file of options.markdownRoots ?? DEFAULT_MARKDOWN_ROOTS.filter(path => path !== "docs")) {
    try { if ((await stat(join(root, file))).isFile()) add(join(root, file)); } catch { /* Optional root document is absent. */ }
  }
  for (const file of await packageEntryFiles(root)) add(file);
  return [...output].sort();
}
