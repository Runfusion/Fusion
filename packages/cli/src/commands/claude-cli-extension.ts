/**
 * Resolver for the vendored `@fusion/pi-claude-cli` pi extension.
 *
 * `@fusion/pi-claude-cli` is a workspace package at `packages/pi-claude-cli/`,
 * a soft fork of rchern/pi-claude-cli (see that package's UPSTREAM.md). It
 * ships its extension entry as raw `.ts` source — pi's loader compiles TS on
 * the fly via jiti, so we just need to point pi at the right file.
 *
 * We deliberately do NOT auto-add "npm:@fusion/pi-claude-cli" to the user's
 * ~/.fusion/agent/settings.json packages array. The package is resolved from
 * this workspace at runtime and loaded explicitly only when
 * GlobalSettings.useClaudeCli is true — this avoids polluting user-owned
 * config files and lets us gate the extension on a UI toggle without
 * settings.json churn.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

/**
 * Outcome of resolving the bundled @fusion/pi-claude-cli extension entry.
 *
 * - `"ok"`: the absolute path to the extension file was found — push it into
 *   the paths array passed to `discoverAndLoadExtensions`.
 * - `"not-installed"`: the package isn't in node_modules (unusual — it's a
 *   hard dep, so this typically means a corrupted install).
 * - `"missing-entry"`: the package is present but its package.json doesn't
 *   declare a pi.extensions entry, or the file it points to doesn't exist.
 *   Indicates a @fusion/pi-claude-cli version mismatch or a broken upstream release.
 * - `"error"`: something unexpected — the reason is captured so the caller
 *   can surface it in the provider card.
 */
export type ClaudeCliExtensionResolution =
  | { status: "ok"; path: string; packageVersion: string }
  | { status: "not-installed" }
  | { status: "missing-entry"; reason: string }
  | { status: "error"; reason: string };

/**
 * Resolve the absolute path to `@fusion/pi-claude-cli`'s pi extension entry file.
 *
 * The package is bundled into the published @runfusion/fusion as
 * `dist/pi-claude-cli/` (see tsup.config.ts) so it is not a runtime npm
 * dependency. We look for that bundled copy first by walking up from this
 * module's location, and fall back to `require.resolve` for monorepo
 * dev/test runs where this file executes from `src/` rather than `dist/`.
 */
export function resolveClaudeCliExtension(): ClaudeCliExtensionResolution {
  let pkgJsonPath: string | undefined;

  // Bundled lookup: when running from dist/, sibling dir dist/pi-claude-cli/
  // holds the staged extension. Walk up a few levels to also catch nested
  // layouts (e.g. dist/commands/foo.js) without hard-coding depth.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["pi-claude-cli", "../pi-claude-cli", "../../pi-claude-cli"]) {
    const candidate = resolve(here, rel, "package.json");
    if (existsSync(candidate)) {
      pkgJsonPath = candidate;
      break;
    }
  }

  if (!pkgJsonPath) {
    try {
      pkgJsonPath = require_.resolve("@fusion/pi-claude-cli/package.json");
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
      reason: `Failed to read @fusion/pi-claude-cli package.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const extensions = pkgJson.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/pi-claude-cli package.json has no pi.extensions array",
    };
  }

  const rawEntry = extensions[0];
  if (typeof rawEntry !== "string" || rawEntry.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/pi-claude-cli pi.extensions[0] is not a valid path string",
    };
  }

  const entryPath = resolve(dirname(pkgJsonPath), rawEntry);
  if (!existsSync(entryPath)) {
    return {
      status: "missing-entry",
      reason: `@fusion/pi-claude-cli extension file not found at ${entryPath}`,
    };
  }

  return {
    status: "ok",
    path: entryPath,
    packageVersion: pkgJson.version ?? "unknown",
  };
}

/**
 * Compute the paths to append to `discoverAndLoadExtensions`' configuredPaths
 * based on the user's `useClaudeCli` setting.
 *
 * When the setting is off we return no paths at all — the bundled
 * `@fusion/pi-claude-cli` sits idle in node_modules and contributes nothing
 * to the running pi session. Flipping the toggle on requires a server
 * restart to pick up the new extension (pi has no stable runtime-reload API
 * for custom provider registrations). The dashboard toggle hook surfaces
 * this in its status response.
 *
 * `warning` is populated when resolution fails (corrupted install, missing
 * entry). Callers should log it but must not fail startup — the feature is
 * optional.
 */
export function resolveClaudeCliExtensionPaths(globalSettings: {
  useClaudeCli?: unknown;
}): { paths: string[]; warning?: string; resolution: ClaudeCliExtensionResolution | null } {
  const enabled = globalSettings?.useClaudeCli === true;
  if (!enabled) {
    return { paths: [], resolution: null };
  }

  const resolution = resolveClaudeCliExtension();
  switch (resolution.status) {
    case "ok":
      return { paths: [resolution.path], resolution };
    case "not-installed":
      return {
        paths: [],
        resolution,
        warning:
          "useClaudeCli is on but @fusion/pi-claude-cli is not installed in node_modules. Run `pnpm install`.",
      };
    case "missing-entry":
    case "error":
      return { paths: [], resolution, warning: resolution.reason };
  }
}

/**
 * Last-observed resolution cached per-process. Populated by the CLI bootstrap
 * (serve/daemon/dashboard) immediately after calling
 * `resolveClaudeCliExtensionPaths`, so HTTP endpoints like
 * GET /api/providers/claude-cli/status can report the same view of the world
 * that the extension loader saw without re-probing node_modules on every
 * request.
 */
let cachedResolution: ClaudeCliExtensionResolution | null = null;

export function setCachedClaudeCliResolution(
  resolution: ClaudeCliExtensionResolution | null,
): void {
  cachedResolution = resolution;
}

export function getCachedClaudeCliResolution(): ClaudeCliExtensionResolution | null {
  return cachedResolution;
}

/**
 * Test helper: allow tests to point the resolver at a fake package.
 * Call with `undefined` to restore the real resolver. Never used in prod.
 */
// Exported for use by tests — see claude-cli-extension.test.ts
export const _testInternals = {
  moduleUrl: (): string => fileURLToPath(import.meta.url),
};
