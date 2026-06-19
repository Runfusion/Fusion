/*
FNXC:DevWorkflow 2026-06-18-16:50:
FN-6638 stale-dist guard. The running Fusion process loads built `dist/` for
@fusion/core, @fusion/engine, and @fusion/dashboard (directly, via plugins, via
dist-resolving sub-imports, or whenever a non-dev/packaged `fn` runs). When a
long-lived process or a stale build runs `dist/` that is OLDER than the `src/`
on disk, landed fixes silently never execute — that is how FN-6644/6647/6648
(and others) appeared "fixed" for ~2 days while the running engine still parked
completed tasks failed. This module computes that staleness so startup can warn
loudly (rebuild + restart) instead of running phantom-old code.

Design / guardrails:
- Pure + injectable (fs + now) so it is unit-testable and never throws into the
  startup path.
- A package is only evaluated when BOTH its `src/` and `dist/` exist. Missing
  `dist/` = running purely from source (fresh, not stale). Missing `src/` =
  packaged/published install with no source tree to compare against (not stale).
- Staleness = newest `.ts`/`.tsx` mtime under `src/` is NEWER than the package's
  dist build marker (newest `.js` mtime under `dist/`), beyond a small slack to
  absorb filesystem mtime jitter.
*/

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PACKAGES = ["core", "engine", "dashboard"];
// Slack absorbs build/checkout mtime jitter so we only flag a real source-ahead.
const DEFAULT_SLACK_MS = 2_000;
const SRC_EXTENSIONS = [".ts", ".tsx"];
const DIST_EXTENSIONS = [".js"];
// Never descend into these — they are not the package's own emitted output.
const SKIP_DIRS = new Set(["node_modules", ".git", "__tests__", "coverage"]);

function newestMtimeMs(dir, extensions, fs) {
  let newest = 0;
  let stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(join(current, entry.name));
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      try {
        const ms = fs.statSync(join(current, entry.name)).mtimeMs;
        if (ms > newest) newest = ms;
      } catch {
        // unreadable file — ignore, do not let it break the scan
      }
    }
  }
  return newest;
}

/**
 * Compute dist staleness for a source checkout.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] repo root (defaults to cwd)
 * @param {string[]} [options.packages] package dir names under packages/
 * @param {number} [options.slackMs] mtime slack
 * @param {object} [options.fs] fs seam ({ existsSync, readdirSync, statSync })
 * @returns {{ stale: boolean, packages: Array<{ name: string, srcNewestMs: number, distNewestMs: number, stale: boolean }> }}
 */
export function computeDistStaleness(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const packages = options.packages ?? DEFAULT_PACKAGES;
  const slackMs = options.slackMs ?? DEFAULT_SLACK_MS;
  const fs = options.fs ?? { existsSync, readdirSync, statSync };

  const results = [];
  for (const name of packages) {
    const srcDir = join(rootDir, "packages", name, "src");
    const distDir = join(rootDir, "packages", name, "dist");
    // Both must exist: no src = packaged install; no dist = pure source run.
    if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) continue;
    const srcNewestMs = newestMtimeMs(srcDir, SRC_EXTENSIONS, fs);
    const distNewestMs = newestMtimeMs(distDir, DIST_EXTENSIONS, fs);
    if (srcNewestMs === 0 || distNewestMs === 0) continue;
    const stale = srcNewestMs - distNewestMs > slackMs;
    results.push({ name, srcNewestMs, distNewestMs, stale });
  }
  return { stale: results.some((r) => r.stale), packages: results };
}

/**
 * Build the operator warning lines for a stale result (or null when fresh).
 * Kept separate from I/O so it is testable and the caller owns logging.
 */
export function formatDistStalenessWarning(result) {
  if (!result || !result.stale) return null;
  const staleNames = result.packages.filter((p) => p.stale).map((p) => p.name);
  return [
    "",
    `[fusion] ⚠ STALE BUILD: ${staleNames.map((n) => `@fusion/${n}`).join(", ")} dist/ is OLDER than src/.`,
    "[fusion]   The running process may execute outdated compiled code, so recently landed",
    "[fusion]   fixes will NOT take effect until you rebuild AND restart:",
    "[fusion]     pnpm build   # then restart the dashboard/engine process",
    "[fusion]   (Set FUSION_SKIP_DIST_FRESHNESS_CHECK=1 to silence this check.)",
    "",
  ].join("\n");
}
