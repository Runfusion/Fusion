import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type StaleBundledPlugin = {
  id: string;
  pluginDir: string;
  reason: string;
  newestSrcMtimeMs: number;
  oldestDistMtimeMs: number;
};

export type BundledPluginFreshnessOptions = {
  pluginsRoot?: string;
};

const IGNORED_DIR_NAMES = new Set(["node_modules", "__tests__", ".git"]);

/**
 * FNXC:BundledPlugins 2026-06-17-21:50:
 * Bundled plugin loaders resolve compiled entries before source entries in shipped installs, and prior work showed gitignored compiled output can drift from src and ship stale runtime behavior. Keep this guard generic and mtime-based so every staged bundled plugin gets the same stale-artifact protection that FN-6596 added for Compound Engineering after ce-debug regressed.
 */
export function findStaleBundledPlugins(
  pluginIds: readonly string[],
  opts: BundledPluginFreshnessOptions = {},
): StaleBundledPlugin[] {
  const pluginsRoot = opts.pluginsRoot ?? defaultPluginsRoot();
  const stalePlugins: StaleBundledPlugin[] = [];

  for (const id of pluginIds) {
    const pluginDir = join(pluginsRoot, id);
    const srcDir = join(pluginDir, "src");
    const distDir = join(pluginDir, "dist");
    const distIndexPath = join(distDir, "index.js");

    if (!existsSync(distIndexPath)) {
      continue;
    }

    const newestSrcMtimeMs = newestFileMtimeMs(srcDir);
    const oldestDistMtimeMs = oldestCompiledDistMtimeMs(distDir);

    if (newestSrcMtimeMs === null || oldestDistMtimeMs === null) {
      continue;
    }

    if (newestSrcMtimeMs > oldestDistMtimeMs) {
      stalePlugins.push({
        id,
        pluginDir,
        newestSrcMtimeMs,
        oldestDistMtimeMs,
        reason: `${id} dist is stale relative to src — run pnpm build`,
      });
    }
  }

  return stalePlugins;
}

export function assertBundledPluginsFresh(
  pluginIds: readonly string[],
  opts: BundledPluginFreshnessOptions = {},
): void {
  const stalePlugins = findStaleBundledPlugins(pluginIds, opts);
  if (stalePlugins.length === 0) {
    return;
  }

  const details = stalePlugins.map((plugin) => `- ${plugin.reason} (${plugin.pluginDir})`).join("\n");
  throw new Error(`Stale bundled plugin compiled artifacts detected:\n${details}`);
}

function defaultPluginsRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..", "..", "..", "..", "plugins");
}

function newestFileMtimeMs(rootDir: string): number | null {
  let newest: number | null = null;
  walkFiles(rootDir, (path) => {
    const mtimeMs = statSync(path).mtimeMs;
    newest = newest === null ? mtimeMs : Math.max(newest, mtimeMs);
  });
  return newest;
}

function oldestCompiledDistMtimeMs(rootDir: string): number | null {
  let oldest: number | null = null;
  walkFiles(rootDir, (path) => {
    if (path.endsWith(".map")) {
      return;
    }
    const mtimeMs = statSync(path).mtimeMs;
    oldest = oldest === null ? mtimeMs : Math.min(oldest, mtimeMs);
  });
  return oldest;
}

function walkFiles(rootDir: string, visitFile: (path: string) => void): void {
  if (!existsSync(rootDir)) {
    return;
  }

  const entries = readdirSync(rootDir, { withFileTypes: true, encoding: "utf8" });
  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIR_NAMES.has(entry.name)) {
        walkFiles(entryPath, visitFile);
      }
      continue;
    }
    if (entry.isFile()) {
      visitFile(entryPath);
    }
  }
}
