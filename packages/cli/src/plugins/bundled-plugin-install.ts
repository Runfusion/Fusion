import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginManifest, type PluginInstallation, type PluginLoader, type PluginManifest, type PluginStore } from "@fusion/core";

const DEPENDENCY_GRAPH_PLUGIN_ID = "fusion-plugin-dependency-graph";

export const BUNDLED_PLUGIN_IDS = [
  "fusion-plugin-dependency-graph",
  "fusion-plugin-hermes-runtime",
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-paperclip-runtime",
] as const;

export type BundledPluginId = (typeof BUNDLED_PLUGIN_IDS)[number];

export function isBundledPluginId(id: string): id is BundledPluginId {
  return (BUNDLED_PLUGIN_IDS as readonly string[]).includes(id);
}

export type EnsureBundledResult =
  | "installed"
  | "updated"
  | "already-installed"
  | "missing-bundle";

function getCandidatePluginDirs(pluginId: string): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cliPackageRoot = resolve(moduleDir, "..", "..");

  return [
    join(cliPackageRoot, "dist", "plugins", pluginId),
    join(cliPackageRoot, "plugins", pluginId),
    join(cliPackageRoot, "..", "..", "plugins", pluginId),
  ];
}

async function loadManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = join(pluginDir, "manifest.json");
  const content = await readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(content);
  const validation = validatePluginManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid plugin manifest: ${validation.errors.join(", ")}`);
  }
  return manifest;
}

function resolveBundledPluginDir(pluginId: string): string | null {
  for (const path of getCandidatePluginDirs(pluginId)) {
    if (existsSync(join(path, "manifest.json"))) {
      return path;
    }
  }
  return null;
}

/**
 * Resolve the actual loadable entry FILE path for a plugin directory. Node ESM
 * does not allow directory imports, so we must register the explicit file the
 * loader will dynamic-import. Preference order:
 *   1. ./src/index.ts (workspace/dev source of truth)
 *   2. ./bundled.js   (esbuild-bundled, ships in npm tarball)
 *   3. ./dist/index.js
 *   4. fall back to the directory itself
 */
export function resolvePluginEntryPath(pluginDir: string): string {
  const candidates = [
    join(pluginDir, "src", "index.ts"),
    join(pluginDir, "bundled.js"),
    join(pluginDir, "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return pluginDir;
}

export async function ensureBundledPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  pluginId: string,
): Promise<EnsureBundledResult> {
  let existingPlugin: PluginInstallation | null = null;
  try {
    existingPlugin = await pluginStore.getPlugin(pluginId);
  } catch {
    // Continue; plugin not installed yet.
  }

  const bundledDir = resolveBundledPluginDir(pluginId);
  if (!bundledDir) {
    return "missing-bundle";
  }

  const manifest = await loadManifest(bundledDir);
  const entryPath = resolvePluginEntryPath(bundledDir);

  if (existingPlugin) {
    const pathChanged = existingPlugin.path !== entryPath;
    const versionChanged = existingPlugin.version !== manifest.version;

    if (!pathChanged && !versionChanged) {
      if (existingPlugin.enabled) {
        try {
          await pluginLoader.loadPlugin(existingPlugin.id);
        } catch {
          // best-effort
        }
      }
      return "already-installed";
    }

    await pluginStore.updatePlugin(pluginId, {
      ...(pathChanged ? { path: entryPath } : {}),
      ...(versionChanged ? { version: manifest.version } : {}),
    });

    if (existingPlugin.enabled) {
      try {
        await pluginLoader.loadPlugin(existingPlugin.id);
      } catch {
        // best-effort
      }
    }

    return "updated";
  }

  const plugin = await pluginStore.registerPlugin({
    manifest,
    path: entryPath,
  });

  if (plugin.enabled) {
    try {
      await pluginLoader.loadPlugin(plugin.id);
    } catch {
      // best-effort
    }
  }

  return "installed";
}

/**
 * @deprecated Use {@link ensureBundledPluginInstalled} with the explicit plugin id.
 * Kept for backwards compatibility with existing call sites.
 */
export async function ensureBundledDependencyGraphPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
): Promise<EnsureBundledResult> {
  return ensureBundledPluginInstalled(pluginStore, pluginLoader, DEPENDENCY_GRAPH_PLUGIN_ID);
}
