/**
 * Resolver for the CLI's own pi extension (`@runfusion/fusion`).
 *
 * `packages/cli/src/extension.ts` registers all `fn_*` tools (`fn_task_create`,
 * `fn_mission_create`, etc.). For these to appear in pi sessions launched by
 * the dashboard/daemon (e.g. agent chat using pi-claude-cli), the extension
 * must be loaded by pi's `discoverAndLoadExtensions`.
 *
 * Pi normally only loads extensions that are registered in
 * `~/.pi/agent/settings.json` packages or symlinked into an extensions
 * directory. To avoid requiring users to `pi install npm:@runfusion/fusion`
 * before fn_* tools work, we resolve the bundled extension path at runtime
 * and inject it into the load list — same pattern as
 * `claude-cli-extension.ts` does for `@fusion/pi-claude-cli`.
 *
 * In dev (`pnpm dev dashboard`), this resolves to `packages/cli/src/extension.ts`.
 * In a published install, it resolves to `<install>/dist/extension.js`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SelfExtensionResolution =
  | { status: "ok"; path: string; packageVersion: string }
  | { status: "missing"; reason: string };

/**
 * Resolve the absolute path to the cli's own pi extension entry file.
 *
 * Walk up from this module to the @runfusion/fusion package.json and read
 * `pi.extensions[0]`. Prefer `src/extension.ts` over `dist/extension.js` when
 * both exist so dev iterations don't require a rebuild.
 */
export function resolveSelfExtension(): SelfExtensionResolution {
  const here = dirname(fileURLToPath(import.meta.url));

  let pkgDir: string | undefined;
  let cur = here;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(cur, "package.json"))) {
      try {
        const parsed = JSON.parse(readFileSync(resolve(cur, "package.json"), "utf-8")) as { name?: string };
        if (parsed.name === "@runfusion/fusion") {
          pkgDir = cur;
          break;
        }
      } catch {
        // ignore and keep walking
      }
    }
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }

  if (!pkgDir) {
    return { status: "missing", reason: "Could not locate @runfusion/fusion package.json from CLI module" };
  }

  let pkgJson: { pi?: { extensions?: unknown }; version?: string };
  try {
    pkgJson = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf-8")) as typeof pkgJson;
  } catch (err) {
    return { status: "missing", reason: `Failed to read @runfusion/fusion package.json: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Prefer src/extension.ts in dev (always fresh); fall back to pi.extensions[0]
  // (dist/extension.js in production).
  const srcEntry = resolve(pkgDir, "src", "extension.ts");
  if (existsSync(srcEntry)) {
    return { status: "ok", path: srcEntry, packageVersion: pkgJson.version ?? "unknown" };
  }

  const extensions = pkgJson.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return { status: "missing", reason: "@runfusion/fusion package.json has no pi.extensions array" };
  }
  const rawEntry = extensions[0];
  if (typeof rawEntry !== "string" || rawEntry.length === 0) {
    return { status: "missing", reason: "@runfusion/fusion pi.extensions[0] is not a valid path string" };
  }
  const entryPath = resolve(pkgDir, rawEntry);
  if (!existsSync(entryPath)) {
    return { status: "missing", reason: `@runfusion/fusion extension file not found at ${entryPath}` };
  }
  return { status: "ok", path: entryPath, packageVersion: pkgJson.version ?? "unknown" };
}
