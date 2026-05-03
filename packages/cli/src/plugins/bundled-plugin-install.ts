import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginManifest, type PluginLoader, type PluginManifest, type PluginStore } from "@fusion/core";

const DEPENDENCY_GRAPH_PLUGIN_ID = "fusion-plugin-dependency-graph";

function getCandidatePluginPaths(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cliPackageRoot = resolve(moduleDir, "..", "..");

  return [
    join(cliPackageRoot, "dist", "plugins", DEPENDENCY_GRAPH_PLUGIN_ID),
    join(cliPackageRoot, "plugins", DEPENDENCY_GRAPH_PLUGIN_ID),
    join(cliPackageRoot, "..", "..", "plugins", DEPENDENCY_GRAPH_PLUGIN_ID),
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

function resolveBundledDependencyGraphPath(): string | null {
  for (const path of getCandidatePluginPaths()) {
    if (existsSync(join(path, "manifest.json"))) {
      return path;
    }
  }
  return null;
}

export async function ensureBundledDependencyGraphPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
): Promise<"installed" | "already-installed" | "missing-bundle"> {
  try {
    await pluginStore.getPlugin(DEPENDENCY_GRAPH_PLUGIN_ID);
    return "already-installed";
  } catch {
    // Continue; plugin not installed yet.
  }

  const bundledPath = resolveBundledDependencyGraphPath();
  if (!bundledPath) {
    return "missing-bundle";
  }

  const manifest = await loadManifest(bundledPath);
  const plugin = await pluginStore.registerPlugin({
    manifest,
    path: bundledPath,
  });

  if (plugin.enabled) {
    await pluginLoader.loadPlugin(plugin.id);
  }

  return "installed";
}
