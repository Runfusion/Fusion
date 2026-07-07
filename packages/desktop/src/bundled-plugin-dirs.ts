/**
 * FNXC:DesktopRuntime 2026-07-07-12:30:
 * FN-7637: bundle-directory resolution is the ONLY host-specific input the shared
 * @fusion/core `ensureBundledPluginInstalled` helper needs (see packages/core/src/plugins/bundled-plugin-install.ts).
 * The CLI stages bundled plugins under `<cli>/dist/plugins/<manifest-id>/`; desktop's
 * packaged closure instead carries the same plugins as `@fusion-plugin-examples/<short-name>`
 * workspace packages (dependencies of `@fusion/dashboard`, materialized into the desktop
 * `pnpm deploy` closure by `packages/desktop/scripts/workspace-tools.ts#stageDesktopDeploy` —
 * see FN-7637 Step 1 investigation, task document "decision"). Every bundled plugin's
 * manifest `id` is `fusion-plugin-<short-name>` and its npm package name is
 * `@fusion-plugin-examples/<short-name>` — a mechanical transform, not a hardcoded table.
 *
 * Resolution uses `import.meta.resolve` against the package's declared "." export
 * (which points at `./dist/index.js`) rather than manual node_modules traversal, so it
 * works correctly under both flat/hoisted (desktop deploy) and nested (workspace dev)
 * `node_modules` layouts. The manifest.json sits at the package root (one directory above
 * `dist/`), so the resolved dist/index.js path is walked up two directories to get the
 * candidate bundle directory. A plugin that desktop does not depend on (e.g. `reports`,
 * `whatsapp-chat`, `linear-import` — not `@fusion/dashboard` deps) has no resolvable
 * package and this returns an empty candidate list, which `ensureBundledPluginInstalled`
 * correctly reports as `missing-bundle` (parity with the CLI's "not found in this build").
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Manifest id (e.g. "fusion-plugin-hermes-runtime") -> npm package short name (e.g. "hermes-runtime"). */
function toPackageShortName(pluginId: string): string {
  return pluginId.replace(/^fusion-plugin-/, "");
}

/**
 * Resolve the candidate bundle directory (directory containing `manifest.json`) for a
 * bundled plugin id under the desktop/dashboard `node_modules` resolution root. Returns
 * an empty array when the corresponding `@fusion-plugin-examples/<short-name>` package is
 * not installed in this closure (desktop does not bundle every CLI-bundled plugin).
 *
 * `resolveSpecifier` defaults to this module's own `import.meta.resolve` (Node exposes it as
 * a writable/configurable own property) and is overridable purely for unit testing — each ES
 * module has its own distinct `import.meta`, so a caller/test module cannot patch this
 * module's resolver from the outside without an injectable seam.
 */
export function resolveDesktopBundlePluginDirs(
  pluginId: string,
  resolveSpecifier: (specifier: string) => string = import.meta.resolve,
): string[] {
  const packageName = `@fusion-plugin-examples/${toPackageShortName(pluginId)}`;
  try {
    // import.meta.resolve applies Node's package "exports" resolution algorithm without
    // requiring the target file to exist on disk, so this works even before `dist/` is built
    // in a dev worktree — it only fails (throws) when the package itself isn't resolvable.
    const resolvedUrl = resolveSpecifier(packageName);
    const resolvedEntryPath = fileURLToPath(resolvedUrl);
    // resolvedEntryPath is ".../<package-root>/dist/index.js"; the package root (where
    // manifest.json lives) is two directories up.
    const packageRoot = dirname(dirname(resolvedEntryPath));
    return [packageRoot];
  } catch {
    return [];
  }
}
