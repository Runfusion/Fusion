/**
 * FNXC:PluginLoader 2026-07-07-00:00:
 * Bundled-plugin auto-install is host-agnostic in @fusion/core. Hosts (the CLI's
 * `<cli>/dist/plugins/<id>` staging layout vs the desktop `@fusion-plugin-examples/<short>`
 * node_modules layout) supply their own bundle-directory resolution — the ONLY
 * host-specific concern — via the `getCandidatePluginDirs` parameter below. This
 * lets the identical install/update/fail-soft-load logic run under both the CLI
 * `dashboard`/`serve`/`daemon` commands and the desktop embedded runtime
 * (`local-runtime.ts` / `local-server.ts`) without `packages/desktop` depending on
 * the CLI package (FN-7637; builds on FN-7623's desktop pluginStore/pluginLoader
 * wiring). Everything below except `getCandidatePluginDirs`/`resolveBundledPluginDir`
 * is a direct, behavior-preserving port of `packages/cli/src/plugins/bundled-plugin-install.ts`.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePluginManifest } from "./plugin-types.js";
import type { PluginInstallation, PluginManifest } from "./plugin-types.js";
import { resolvePluginEntryPath } from "./plugin-loader.js";
import type { PluginLoader } from "./plugin-loader.js";
import type { PluginStore } from "../stores/plugin-store.js";

const DEPENDENCY_GRAPH_PLUGIN_ID = "fusion-plugin-dependency-graph";
const CURSOR_RUNTIME_PLUGIN_ID = "fusion-plugin-cursor-runtime";
const GROK_RUNTIME_PLUGIN_ID = "fusion-plugin-grok-runtime";
export const CLAUDE_RUNTIME_PLUGIN_ID = "fusion-plugin-claude-runtime";

export const BUNDLED_PLUGIN_IDS = [
  "fusion-plugin-dependency-graph",
  "fusion-plugin-reports",
  "fusion-plugin-whatsapp-chat",
  "fusion-plugin-roadmap",
  "fusion-plugin-hermes-runtime",
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-paperclip-runtime",
  "fusion-plugin-cursor-runtime",
  "fusion-plugin-grok-runtime",
  "fusion-plugin-claude-runtime",
  // FNXC:OmpAcp 2026-07-11-23:35: Oh My Pi ACP runtime available as a staged/bundled install target.
  "fusion-plugin-omp-runtime",
  "fusion-plugin-cli-printing-press",
  "fusion-plugin-compound-engineering",
  "fusion-plugin-linear-import",
  "fusion-plugin-quality",
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

/** Host-supplied resolver: given a plugin id, return candidate directories to probe for `manifest.json`. */
export type BundledPluginDirResolver = (pluginId: string) => string[];

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

function resolveBundledPluginDir(pluginId: string, getCandidatePluginDirs: BundledPluginDirResolver): string | null {
  for (const path of getCandidatePluginDirs(pluginId)) {
    if (existsSync(join(path, "manifest.json"))) {
      return path;
    }
  }
  return null;
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ensure a bundled runtime plugin is registered (and, if enabled, loaded) in the
 * given `pluginStore`/`pluginLoader`. The only host-specific input is
 * `getCandidatePluginDirs`, which returns the ordered list of directories to probe
 * for a `manifest.json` for the given plugin id — the CLI supplies its
 * `<cli>/dist/plugins/<id>` search paths, desktop supplies its
 * `node_modules/@fusion-plugin-examples/<short>` resolution. See `resolvePluginEntryPath`
 * (also in `@fusion/core`) for the loadable-entry-file selection this helper reuses
 * rather than re-duplicating.
 */
export async function ensureBundledPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  pluginId: string,
  getCandidatePluginDirs: BundledPluginDirResolver,
): Promise<EnsureBundledResult> {
  let existingPlugin: PluginInstallation | null = null;
  try {
    existingPlugin = await pluginStore.getPlugin(pluginId);
  } catch {
    // Continue; plugin not installed yet.
  }

  const bundledDir = resolveBundledPluginDir(pluginId, getCandidatePluginDirs);
  if (!bundledDir) {
    return "missing-bundle";
  }

  const manifest = await loadManifest(bundledDir);
  const entryPath = resolvePluginEntryPath(bundledDir);

  if (!entryPath) {
    console.warn(`[plugins] Bundled plugin "${pluginId}" is missing a loadable entry file in ${bundledDir}`);
    return "missing-bundle";
  }

  if (existingPlugin) {
    const existingPathIsDirectory = isDirectoryPath(existingPlugin.path);
    const pathChanged = existingPathIsDirectory || existingPlugin.path !== entryPath;
    const versionChanged = existingPlugin.version !== manifest.version;

    if (!pathChanged && !versionChanged) {
      if (existingPlugin.enabled) {
        try {
          await pluginLoader.loadPlugin(existingPlugin.id);
        } catch (err) {
          console.warn("[plugins] failed to load bundled plugin", existingPlugin.id, err);
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
      } catch (err) {
        console.warn("[plugins] failed to load bundled plugin", existingPlugin.id, err);
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
    } catch (err) {
      console.warn("[plugins] failed to load bundled plugin", plugin.id, err);
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
  getCandidatePluginDirs: BundledPluginDirResolver,
): Promise<EnsureBundledResult> {
  return ensureBundledPluginInstalled(pluginStore, pluginLoader, DEPENDENCY_GRAPH_PLUGIN_ID, getCandidatePluginDirs);
}

export async function ensureBundledCursorRuntimePluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  getCandidatePluginDirs: BundledPluginDirResolver,
): Promise<EnsureBundledResult> {
  return ensureBundledPluginInstalled(pluginStore, pluginLoader, CURSOR_RUNTIME_PLUGIN_ID, getCandidatePluginDirs);
}

export async function ensureBundledGrokRuntimePluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  getCandidatePluginDirs: BundledPluginDirResolver,
): Promise<EnsureBundledResult> {
  return ensureBundledPluginInstalled(pluginStore, pluginLoader, GROK_RUNTIME_PLUGIN_ID, getCandidatePluginDirs);
}
