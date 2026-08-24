#!/usr/bin/env node
/*
FNXC:UpdateChannels 2026-08-18-07:20:
Requirement: a PR must never regress the beta cycle recorded in `.changeset/pre.json`.

Motivating incident (v0.77.0-beta.2): PR #3472 resolved a pre.json rebase conflict
against a copy predating the v0.76.0 stable, reverting `initialVersions` 0.76.0 ->
0.75.1 and swapping the consumed-changeset ledger for the older cycle's list. Nothing
failed at PR time. Days later `pnpm release` saw the cycle anchored below the shipped
v0.76.0, fired its stale-cycle re-anchor (`pre exit` -> rewrite versions -> `pre enter`),
and proposed 0.77.0-beta.0 — BELOW the already-published 0.77.0-beta.1. The re-anchor
guard exists to stop a beta numbering under a stable; fed a stale anchor it caused
exactly that. pre.json is edited by no one and conflicts in nearly every long-lived
branch, so a wrong resolution is silent until release day. This check moves that
failure to the PR that causes it.

Three invariants, all cheap and all failing loudly rather than warning:

1. `anchor-below-stable` — `initialVersions["@runfusion/fusion"]` must not sit below the
   newest published stable tag. This is the exact predicate `evaluateBetaCycleAnchor`
   keys on in scripts/release.mjs, so a green check here means the release will NOT
   re-anchor. Caught #3472 (0.75.1 < 0.76.0).
2. `ledger-regression` — the consumed-changeset ledger must remain a SUPERSET of the
   ledger at the last `chore(release):` commit. Deliberately a superset test, not a
   count test: #3472's ledger GREW 67 -> 158 while dropping all 67 real entries, so a
   size comparison would have passed it. Losing an entry means that changeset's notes
   silently vanish from the eventual stable aggregation.
3. `dangling-ledger-entry` — every consumed entry must still have its `.changeset/*.md`
   file. In pre-mode `changeset version` records consumed changesets and KEEPS the .md
   so the stable release can aggregate them; a merge that deletes the file while keeping
   the entry drops it from the release notes.

Skips cleanly when not in pre-mode (the stable track deletes pre.json via `pre exit`).
Invariant 2 needs the last release commit in local history; on a shallow clone with no
release commit reachable it reports SKIPPED rather than passing vacuously — invariants 1
and 3 are purely local and always run.
*/
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";

import { compareReleaseVersions, latestStableVersionFromTags } from "./lib/release-version-anchor.mjs";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
/** The fixed-group package whose version anchors every X.Y.Z-beta.N. */
export const ANCHOR_PACKAGE = "@runfusion/fusion";

/**
 * Pure evaluator. All git/filesystem access is done by the caller so the
 * invariants are testable without a repo fixture.
 *
 * @param {object} input
 * @param {object|null} input.preState        parsed .changeset/pre.json, or null when absent
 * @param {string|null} input.latestStable    e.g. "0.76.0", or null when no stable tag exists
 * @param {string[]} input.changesetFiles     `.changeset/*.md` basenames WITHOUT the extension
 * @param {object|null} input.baselinePreState pre.json at the last `chore(release):` commit
 * @returns {{ violations: {rule: string, message: string}[], skipped: string[] }}
 */
export function evaluatePreJsonInvariants({ preState, latestStable, changesetFiles, baselinePreState }) {
  const violations = [];
  const skipped = [];

  // Not in a pre-mode cycle: the stable track owns this state and pre.json is absent.
  if (!preState || preState.mode !== "pre") return { violations, skipped };

  const anchor = preState.initialVersions?.[ANCHOR_PACKAGE] ?? null;
  const ledger = preState.changesets ?? [];

  // 1. anchor-below-stable
  if (!anchor) {
    violations.push({
      rule: "anchor-below-stable",
      message: `pre.json has no initialVersions["${ANCHOR_PACKAGE}"]; the beta cycle has no anchor to derive X.Y.Z-beta.N from.`,
    });
  } else if (latestStable && compareReleaseVersions(anchor, latestStable) < 0) {
    violations.push({
      rule: "anchor-below-stable",
      message:
        `pre.json is anchored at ${anchor}, below the shipped stable v${latestStable}.\n` +
        `    scripts/release.mjs will treat this cycle as stale and re-anchor (pre exit -> rewrite versions -> pre enter),\n` +
        `    resetting the ledger and proposing a beta BELOW the betas already published on v${latestStable}.\n` +
        `    Almost always a pre.json merge/rebase conflict resolved against a pre-v${latestStable} copy.\n` +
        `    Fix: git checkout <last chore(release) tag> -- .changeset/pre.json`,
    });
  }

  // 2. ledger-regression (needs a baseline from history)
  if (!baselinePreState) {
    skipped.push("ledger-regression (no `chore(release):` commit for .changeset/pre.json in local history)");
  } else {
    const baselineLedger = baselinePreState.changesets ?? [];
    const current = new Set(ledger);
    const dropped = baselineLedger.filter((name) => !current.has(name));
    if (dropped.length > 0) {
      violations.push({
        rule: "ledger-regression",
        message:
          `pre.json's consumed-changeset ledger dropped ${dropped.length} entr${dropped.length === 1 ? "y" : "ies"} present at the last release:\n` +
          dropped.slice(0, 10).map((name) => `      - ${name}`).join("\n") +
          (dropped.length > 10 ? `\n      … and ${dropped.length - 10} more` : "") +
          `\n    A consumed changeset dropped from the ledger loses its notes from the eventual stable release.\n` +
          `    Ledger size alone is not the signal — it can grow while dropping every real entry.`,
      });
    }
  }

  // 3. dangling-ledger-entry
  const present = new Set(changesetFiles);
  const dangling = ledger.filter((name) => !present.has(name));
  if (dangling.length > 0) {
    violations.push({
      rule: "dangling-ledger-entry",
      message:
        `${dangling.length} consumed changeset${dangling.length === 1 ? "" : "s"} in the ledger no longer ha${dangling.length === 1 ? "s" : "ve"} a .changeset/*.md file:\n` +
        dangling.slice(0, 10).map((name) => `      - ${name}.md`).join("\n") +
        (dangling.length > 10 ? `\n      … and ${dangling.length - 10} more` : "") +
        `\n    Pre-mode keeps consumed .md files so the stable release can aggregate them; deleting one drops it from the notes.`,
    });
  }

  return { violations, skipped };
}

function git(args, { allowFail = true } = {}) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) return null;
  return r.status === 0 ? r.stdout : null;
}

/** Local `v*` tags; falls back to the remote when a shallow CI clone has none. */
export function readStableTags() {
  const local = git(["tag", "--list", "v*"]) ?? "";
  if (latestStableVersionFromTags(local) !== null) return local;
  const remote = git(["ls-remote", "--tags", "origin", "v*"]) ?? "";
  // ls-remote emits "<sha>\trefs/tags/v0.76.0"; reduce to bare tag names.
  return remote
    .split("\n")
    .map((line) => line.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/tags/") && !ref.endsWith("^{}"))
    .map((ref) => ref.slice("refs/tags/".length))
    .join("\n");
}

/** pre.json as of the newest `chore(release):` commit that touched it. */
export function readBaselinePreState() {
  const sha = (git(["log", "--format=%H", "--grep=^chore(release):", "-n", "1", "--", ".changeset/pre.json"]) ?? "").trim();
  if (!sha) return null;
  const blob = git(["show", `${sha}:.changeset/pre.json`]);
  if (!blob) return null;
  try {
    return { sha, state: JSON.parse(blob) };
  } catch {
    return null;
  }
}

export function main() {
  const prePath = join(repoRoot, ".changeset", "pre.json");
  let preState = null;
  if (existsSync(prePath)) {
    try {
      preState = JSON.parse(readFileSync(prePath, "utf8"));
    } catch (error) {
      console.error(`✗ .changeset/pre.json is not valid JSON: ${error.message}`);
      return 1;
    }
  }
  if (!preState || preState.mode !== "pre") {
    console.log("✓ pre.json anchor: not in changesets pre-mode (stable track) — nothing to check.");
    return 0;
  }

  const changesetFiles = readdirSync(join(repoRoot, ".changeset"))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -3));
  const baseline = readBaselinePreState();
  const latestStable = latestStableVersionFromTags(readStableTags());

  const { violations, skipped } = evaluatePreJsonInvariants({
    preState,
    latestStable,
    changesetFiles,
    baselinePreState: baseline?.state ?? null,
  });

  for (const note of skipped) console.log(`  SKIPPED: ${note}`);

  if (violations.length > 0) {
    console.error(`\n✗ .changeset/pre.json regressed the beta release cycle (${violations.length} violation${violations.length === 1 ? "" : "s"}):\n`);
    for (const v of violations) console.error(`  [${v.rule}] ${v.message}\n`);
    console.error(
      "  pre.json is generated by changesets and hand-edited by no one. If this fired on a rebase,\n" +
      "  take the version from the branch you are merging INTO, never the older side.\n",
    );
    return 1;
  }

  const anchor = preState.initialVersions?.[ANCHOR_PACKAGE];
  console.log(
    `✓ pre.json anchor: cycle anchored at ${anchor} (stable v${latestStable ?? "none"}), ` +
    `${(preState.changesets ?? []).length} consumed changesets intact.`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("check-pre-json-anchor.mjs")) {
  process.exit(main());
}
