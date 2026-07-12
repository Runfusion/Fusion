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

/*
FNXC:PluginLoader 2026-07-10-00:00:
Candidate order encodes a freshness contract, not just a search path.

Published/global install (the regression the first candidate protects): plugins
are staged next to the running bin at `<cli>/dist/plugins/<id>`, and no workspace
`plugins/` dir exists — so `join(moduleDir, "plugins", <id>)` MUST stay first and
win.

Source checkout / `pnpm dev` (the durability fix): the running dashboard would
otherwise resolve the STAGED tsup bundle at `<cli>/dist/plugins/<id>/bundled.js`,
which `resolvePluginEntryPath` prefers verbatim with NO freshness check. That
bundle is a build artifact only `tsup` regenerates — the FN-7779 dev prebuild
rebuilds each plugin's OWN `plugins/<id>/dist` but never the staged bundle, so a
source-only plugin fix (e.g. the FN-7796 Grok adapter) silently ran stale and
grok chat returned empty replies. Probe the workspace source dir
(`<repo>/plugins/<id>`) BEFORE the staged bundle so dev loads the live plugin
whose entry `resolvePluginEntryPath` freshness-checks (dist vs src) — self-healing
even when the prebuild is skipped. The workspace dir only exists in a checkout, so
published installs are unaffected.
*/
function getCandidatePluginDirs(pluginId: string): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cliPackageRoot = resolve(moduleDir, "..", "..");

  return [
    // Bundled/global runtime: moduleDir is typically <cli>/dist, and plugins are
    // staged under <cli>/dist/plugins/<id>. Keep first for the global-install regression.
    join(moduleDir, "plugins", pluginId),
    // Source checkout: prefer the live workspace plugin (freshness-checked by
    // resolvePluginEntryPath) over the stale staged tsup bundle below.
    join(cliPackageRoot, "..", "..", "plugins", pluginId),
    // Source/dev fallbacks.
    join(cliPackageRoot, "dist", "plugins", pluginId),
    join(cliPackageRoot, "plugins", pluginId),
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
