/**
 * FNXC:PluginLoader 2026-07-07-00:00:
 * Bundled-plugin auto-install logic was ported to @fusion/core
 * (packages/core/src/plugins/bundled-plugin-install.ts) so the desktop embedded
 * runtime can auto-install bundled runtime plugins without depending on this CLI
 * package (FN-7637). This module is now a thin, behavior-preserving CLI adapter:
 * it supplies the CLI-specific candidate bundle-directory resolution
 * (`<cli>/dist/plugins/<id>` staged layout, resolved from `import.meta.url`) to
 * the shared helper and re-exports the same public surface `dashboard.ts`,
 * `serve.ts`, and `daemon.ts` already depend on. `resolvePluginEntryPath` is
 * re-exported directly from `@fusion/core` (no local duplicate) since the
 * shared helper already delegates to it.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBundledCursorRuntimePluginInstalled as coreEnsureBundledCursorRuntimePluginInstalled,
  ensureBundledGrokRuntimePluginInstalled as coreEnsureBundledGrokRuntimePluginInstalled,
  ensureBundledDependencyGraphPluginInstalled as coreEnsureBundledDependencyGraphPluginInstalled,
  ensureBundledPluginInstalled as coreEnsureBundledPluginInstalled,
  type EnsureBundledResult,
  type PluginLoader,
  type PluginStore,
} from "@fusion/core";

export { BUNDLED_PLUGIN_IDS, isBundledPluginId, resolvePluginEntryPath } from "@fusion/core";
export type { BundledPluginId, EnsureBundledResult } from "@fusion/core";

function getCandidatePluginDirs(pluginId: string): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cliPackageRoot = resolve(moduleDir, "..", "..");

  return [
    // Bundled/global runtime: moduleDir is typically <cli>/dist, and plugins are
    // staged under <cli>/dist/plugins/<id>.
    join(moduleDir, "plugins", pluginId),
    // Source/dev fallbacks.
    join(cliPackageRoot, "dist", "plugins", pluginId),
    join(cliPackageRoot, "plugins", pluginId),
    join(cliPackageRoot, "..", "..", "plugins", pluginId),
  ];
}

export async function ensureBundledPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
  pluginId: string,
): Promise<EnsureBundledResult> {
  return coreEnsureBundledPluginInstalled(pluginStore, pluginLoader, pluginId, getCandidatePluginDirs);
}

/**
 * @deprecated Use {@link ensureBundledPluginInstalled} with the explicit plugin id.
 * Kept for backwards compatibility with existing call sites.
 */
export async function ensureBundledDependencyGraphPluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
): Promise<EnsureBundledResult> {
  return coreEnsureBundledDependencyGraphPluginInstalled(pluginStore, pluginLoader, getCandidatePluginDirs);
}

export async function ensureBundledCursorRuntimePluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
): Promise<EnsureBundledResult> {
  return coreEnsureBundledCursorRuntimePluginInstalled(pluginStore, pluginLoader, getCandidatePluginDirs);
}

export async function ensureBundledGrokRuntimePluginInstalled(
  pluginStore: PluginStore,
  pluginLoader: PluginLoader,
): Promise<EnsureBundledResult> {
  return coreEnsureBundledGrokRuntimePluginInstalled(pluginStore, pluginLoader, getCandidatePluginDirs);
}
