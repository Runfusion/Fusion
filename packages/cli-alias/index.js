#!/usr/bin/env node
// runfusion.ai — tiny alias for @runfusion/fusion.
//
// Exposes four bins: runfusion.ai, runfusion, fn, fusion. Installing this
// package globally (`npm i -g runfusion.ai`) therefore also puts `fn` and
// `fusion` on PATH, even though `@runfusion/fusion` is only a dependency
// (npm does not link dep bins globally).
//
// When invoked as `runfusion.ai` / `runfusion` with no args, defaults to
// launching the dashboard. When invoked as `fn` / `fusion`, forwards args
// verbatim so behavior matches the main CLI exactly (e.g. bare `fn` prints
// help, not `fn dashboard`).

import { basename, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const args = globalThis.process.argv.slice(2);
const invokedAs = basename(globalThis.process.argv[1] || "").replace(/\.(js|cjs|mjs|exe)$/i, "");
const isAliasInvocation = invokedAs === "runfusion.ai" || invokedAs === "runfusion";

if (isAliasInvocation && args.length === 0) {
  // No subcommand → default to dashboard.
  globalThis.process.argv = [globalThis.process.argv[0], globalThis.process.argv[1], "dashboard"];
}

maybeAnnounceUpdateAndRefresh();

await import("@runfusion/fusion/dist/bin.js");

// ──────────────────────────────────────────────────────────────────────────
// Update notice & background refresh.
//
// Reads the existing `~/.fusion/update-check.json` cache that the dashboard
// server writes (packages/dashboard/src/update-check.ts). If a newer version
// is available, prints a one-line stderr notice. To avoid coupling the
// launcher to the dashboard bundle and to keep it fast, we never import
// dashboard code here — we just consume the cache file by its known shape.
//
// If the cache is missing or older than 24h, fires a non-blocking fetch
// against the npm registry and rewrites the cache so users who never open
// the dashboard still pick up updates eventually. Skipped in CI, when
// stderr isn't a TTY, or when FUSION_NO_UPDATE_CHECK=1 is set.
function maybeAnnounceUpdateAndRefresh() {
  try {
    if (process.env.FUSION_NO_UPDATE_CHECK === "1") return;
    if (process.env.CI) return;
    if (!process.stderr.isTTY) return;

    const fusionDir = resolveFusionDir();
    const cachePath = join(fusionDir, "update-check.json");
    const currentVersion = readBundledFusionVersion();

    let cache = null;
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    } catch { /* missing or corrupt — treat as no cache */ }

    if (
      cache &&
      cache.updateAvailable === true &&
      typeof cache.latestVersion === "string" &&
      cache.currentVersion === currentVersion
    ) {
      const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
      const dim = (s) => `\x1b[2m${s}\x1b[0m`;
      process.stderr.write(
        yellow(
          `\nFusion ${cache.latestVersion} is available (you have ${currentVersion}).\n`,
        ) +
          dim(`  Update: npx runfusion.ai@latest\n  Disable: FUSION_NO_UPDATE_CHECK=1\n\n`),
      );
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const stale =
      !cache ||
      typeof cache.lastChecked !== "number" ||
      Date.now() - cache.lastChecked > DAY_MS ||
      cache.currentVersion !== currentVersion;
    if (stale && currentVersion) {
      backgroundRefresh(fusionDir, cachePath, currentVersion).catch(() => {});
    }
  } catch {
    // Update check is best-effort — never block or fail the launcher.
  }
}

function resolveFusionDir() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const preferred = join(home, ".fusion");
  if (existsSync(preferred)) return preferred;
  const legacy = join(home, ".pi", "fusion");
  if (existsSync(legacy)) return legacy;
  return preferred;
}

function readBundledFusionVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@runfusion/fusion/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function backgroundRefresh(fusionDir, cachePath, currentVersion) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch("https://registry.npmjs.org/@runfusion%2Ffusion", {
      signal: controller.signal,
    });
    if (!response.ok) return;
    const payload = await response.json();
    const latestVersion = payload?.["dist-tags"]?.latest;
    if (typeof latestVersion !== "string") return;

    const result = {
      currentVersion,
      latestVersion,
      updateAvailable: isRemoteNewer(latestVersion, currentVersion),
      lastChecked: Date.now(),
    };

    try {
      mkdirSync(fusionDir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(result, null, 2), "utf-8");
    } catch { /* best-effort */ }
  } finally {
    clearTimeout(timeout);
  }
}

function isRemoteNewer(remote, current) {
  const parse = (v) =>
    String(v)
      .split(".")
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const r = parse(remote);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}
