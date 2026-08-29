/*
FNXC:UpdateChannels 2026-07-24-09:40:
Version-anchor rules shared by `scripts/release.mjs` and its tests.

Requirement: after a stable release ships, the NEXT beta must be based on the
stable version that just shipped, and no release may ever number at or below
the newest published stable.

Regression context (v0.73.0): the stable was cut on the `release` branch while
`main` stayed inside the 0.72.0-anchored changesets pre-mode cycle. Because a
beta's version is derived from pre.json's `initialVersions` snapshot, the next
beta on main would have been v0.73.0-beta.7 — older than the published v0.73.0 —
and the dev checkout (`pnpm dev`, dashboard version badge) still reported the
last beta.
*/

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Prerelease-aware semver comparison: returns <0, 0, >0.
 * `1.2.3-beta.1` sorts BELOW `1.2.3`; numeric prerelease identifiers compare
 * numerically (`beta.10` > `beta.9`).
 */
export function compareReleaseVersions(a, b) {
  const [aCore = "", aPre = ""] = String(a).split("-", 2);
  const [bCore = "", bPre = ""] = String(b).split("-", 2);
  const ta = parseCore(aCore);
  const tb = parseCore(bCore);
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
  }
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  const pa = aPre.split(".");
  const pb = bPre.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = /^\d+$/.test(xa) ? Number(xa) : null;
    const nb = /^\d+$/.test(xb) ? Number(xb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

function parseCore(core) {
  const m = String(core).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Highest STABLE version among `v*` git tags. Prerelease tags are ignored on
 * purpose — the beta track is anchored on shipped stables, not on other betas.
 *
 * @param {string[]|string} tags `git tag --list 'v*'` output (raw or split).
 * @returns {string|null} e.g. "0.73.0", or null when no stable tag exists yet.
 */
export function latestStableVersionFromTags(tags) {
  const lines = Array.isArray(tags) ? tags : String(tags).split("\n");
  let best = null;
  for (const line of lines) {
    const tag = String(line).trim();
    if (!tag.startsWith("v")) continue;
    const version = tag.slice(1);
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (best === null || compareReleaseVersions(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Decide whether a beta cycle is still anchored beneath a shipped stable.
 *
 * `cycleBase` is pre.json's `initialVersions["@runfusion/fusion"]` when a
 * pre-mode cycle is open, else the current workspace version. When stale, the
 * caller exits pre-mode, rewrites the fixed-group package versions to `anchor`,
 * and re-enters pre-mode so `changeset version` derives X.Y.Z-beta.N from the
 * shipped stable. Pending changesets are untouched, so their bump type still
 * decides patch-vs-minor of that stable.
 */
export function evaluateBetaCycleAnchor({ cycleBase, latestStable }) {
  if (!latestStable) return { stale: false, anchor: cycleBase ?? null };
  if (!cycleBase) return { stale: true, anchor: latestStable };
  const stale = compareReleaseVersions(cycleBase, latestStable) < 0;
  return { stale, anchor: stale ? latestStable : cycleBase };
}

/**
 * Point each package.json at `version`, skipping files already there or absent.
 * Used to re-anchor the fixed group (plus the workspace root) on the shipped
 * stable before `changeset pre enter`, which snapshots these versions into
 * pre.json's `initialVersions` and derives every X.Y.Z-beta.N from them.
 *
 * @returns {string[]} the paths actually rewritten, so a dry-run can restore them.
 */
export function setPackageJsonVersions(paths, version) {
  const rewritten = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    if (pkg.version === version) continue;
    pkg.version = version;
    writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
    rewritten.push(path);
  }
  return rewritten;
}

/**
 * Backstop applied to both channels: a release must be strictly newer than the
 * newest published stable. Catches hand-edited pre.json, a back-merge resolved
 * the wrong way, and a stale version typed at the override prompt.
 */
export function isVersionAheadOfStable(version, latestStable) {
  if (!latestStable) return true;
  return compareReleaseVersions(version, latestStable) > 0;
}
