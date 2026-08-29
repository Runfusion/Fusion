/**
 * Resolver for the vendored `@fusion/droid-cli` pi extension.
 *
 * `@fusion/droid-cli` is a workspace package at `packages/droid-cli/`. It
 * ships its extension entry as raw `.ts` source — pi's loader compiles TS on
 * the fly via jiti, so we just need to point pi at the right file.
 *
 * We deliberately do NOT auto-add "npm:@fusion/droid-cli" to the user's
 * ~/.fusion/agent/settings.json packages array. The package is resolved from
 * this workspace at runtime and loaded explicitly only when
 * GlobalSettings.useDroidCli is true — this avoids polluting user-owned
 * config files and lets us gate the extension on a UI toggle without
 * settings.json churn.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

/**
 * Outcome of resolving the bundled @fusion/droid-cli extension entry.
 *
 * - `"ok"`: the absolute path to the extension file was found — push it into
 *   the paths array passed to `discoverAndLoadExtensions`.
 * - `"not-installed"`: the package isn't in node_modules (unusual — it's a
 *   hard dep, so this typically means a corrupted install).
 * - `"missing-entry"`: the package is present but its package.json doesn't
 *   declare a pi.extensions entry, or the file it points to doesn't exist.
 *   Indicates a @fusion/droid-cli version mismatch or a broken release.
 * - `"error"`: something unexpected — the reason is captured so the caller
 *   can surface it in the Droid CLI provider card.
 */
export type DroidCliExtensionResolution =
  | { status: "ok"; path: string; packageVersion: string }
  | { status: "not-installed" }
  | { status: "missing-entry"; reason: string }
  | { status: "error"; reason: string };

/**
 * Resolve the absolute path to `@fusion/droid-cli`'s pi extension entry file.
 *
 * The package is bundled into the published @runfusion/fusion as
 * `dist/droid-cli/` (see tsup.config.ts) so it is not a runtime npm
 * dependency. We look for that bundled copy first by walking up from this
 * module's location, and fall back to `require.resolve` for monorepo
 * dev/test runs where this file executes from `src/` rather than `dist/`.
 */
export function resolveDroidCliExtensionFromModuleUrl(
  moduleUrl: string,
): DroidCliExtensionResolution {
  let pkgJsonPath: string | undefined;

  // Bundled lookup: when running from dist/, sibling dir dist/droid-cli/
  // holds the staged extension. Walk up a few levels to also catch nested
  // layouts (e.g. dist/commands/foo.js) without hard-coding depth.
  const here = dirname(fileURLToPath(moduleUrl));
  for (const rel of ["droid-cli", "../droid-cli", "../../droid-cli"]) {
    const candidate = resolve(here, rel, "package.json");
    if (existsSync(candidate)) {
      pkgJsonPath = candidate;
      break;
    }
  }

  if (!pkgJsonPath) {
    try {
      pkgJsonPath = require_.resolve("@fusion/droid-cli/package.json");
    } catch {
      return { status: "not-installed" };
    }
  }

  let pkgJson: { pi?: { extensions?: unknown }; version?: string };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as typeof pkgJson;
  } catch (err) {
    return {
      status: "error",
      reason: `Failed to read @fusion/droid-cli package.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const extensions = pkgJson.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/droid-cli package.json has no pi.extensions array",
    };
  }

  const rawEntry = extensions[0];
  if (typeof rawEntry !== "string" || rawEntry.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/droid-cli pi.extensions[0] is not a valid path string",
    };
  }

  const entryPath = resolve(dirname(pkgJsonPath), rawEntry);
  if (!existsSync(entryPath)) {
    return {
      status: "missing-entry",
      reason: `@fusion/droid-cli extension file not found at ${entryPath}`,
    };
  }

  return {
    status: "ok",
    path: entryPath,
    packageVersion: pkgJson.version ?? "unknown",
  };
}

export function resolveDroidCliExtension(): DroidCliExtensionResolution {
  return resolveDroidCliExtensionFromModuleUrl(import.meta.url);
}

/**
 * Compute the paths to append to `discoverAndLoadExtensions`' configuredPaths
 * based on the user's `useDroidCli` setting.
 *
 * When the setting is off we return no paths at all — the bundled
 * `@fusion/droid-cli` sits idle in node_modules and contributes nothing
 * to the running pi session. Flipping the toggle on requires a server
 * restart to pick up the new extension (pi has no stable runtime-reload API
 * for custom provider registrations). The dashboard toggle hook surfaces
 * this in its status response.
 *
 * `warning` is populated when resolution fails (corrupted install, missing
 * entry). Callers should log it but must not fail startup — the feature is
 * optional.
 */
export function resolveDroidCliExtensionPaths(globalSettings: {
  useDroidCli?: unknown;
}): { paths: string[]; warning?: string; resolution: DroidCliExtensionResolution | null } {
  const enabled = globalSettings?.useDroidCli === true;
  if (!enabled) {
    return { paths: [], resolution: null };
  }

  const resolution = resolveDroidCliExtension();
  switch (resolution.status) {
    case "ok":
      return { paths: [resolution.path], resolution };
    case "not-installed":
      return {
        paths: [],
        resolution,
        warning:
          "useDroidCli is on but @fusion/droid-cli is not installed in node_modules. Run `pnpm install`.",
      };
    case "missing-entry":
    case "error":
      return { paths: [], resolution, warning: resolution.reason };
  }
}

/**
 * Last-observed resolution cached per-process. Populated by the CLI bootstrap
 * (serve/daemon/dashboard) immediately after calling
 * `resolveDroidCliExtensionPaths`, so HTTP endpoints like
 * GET /api/providers/droid-cli/status can report the same view of the world
 * that the extension loader saw without re-probing node_modules on every
 * request.
 */
let cachedResolution: DroidCliExtensionResolution | null = null;

export function setCachedDroidCliResolution(
  resolution: DroidCliExtensionResolution | null,
): void {
  cachedResolution = resolution;
}

export function getCachedDroidCliResolution(): DroidCliExtensionResolution | null {
  return cachedResolution;
}

/**
 * Test helper: allow tests to point the resolver at a fake package.
 * Call with `undefined` to restore the real resolver. Never used in prod.
 */
// Exported for use by tests — see droid-cli-extension.test.ts
export const _testInternals = {
  moduleUrl: (): string => fileURLToPath(import.meta.url),
};
