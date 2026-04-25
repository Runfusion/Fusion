#!/usr/bin/env node
// Local release: consume changesets, bump versions, publish to npm, push tag.
//
// This is a local-machine alternative to the `version.yml` CI workflow.
// Trade-off: CI publishes with npm provenance via OIDC; this script does not.
// If you want provenance, run the workflow manually instead of this script.
//
// Requirements:
//   - clean working tree on `main`, up to date with origin
//   - at least one pending changeset in .changeset/
//   - `npm login` already completed (publish uses the active npm token)
//
// Usage:
//   pnpm release              # interactive, confirms before publish+tag
//   pnpm release --yes        # skip confirmation prompt
//   pnpm release --dry-run    # run through steps without publishing/pushing

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const AUTO_YES = args.has("--yes") || args.has("-y");

const color = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const info = (s) => console.log(color(36, "▶ ") + s);
const ok = (s) => console.log(color(32, "✓ ") + s);
const warn = (s) => console.log(color(33, "! ") + s);
const fail = (s) => {
  console.error(color(31, "✗ ") + s);
  process.exit(1);
};

function run(cmd, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (r.status !== 0 && !allowFail) fail(`Command failed: ${cmd}`);
  return { status: r.status, stdout: (r.stdout || "").trim() };
}

/**
 * Rewrite the repo-root CHANGELOG.md by aggregating every
 * `packages/*\/CHANGELOG.md` into a single per-version view.
 *
 * For each version that appears in any package, we emit a top-level
 * `## <version>` block, then a `### <pkgName>` sub-block per package that
 * had an entry for that version, with the package's section body bumped
 * one heading level deeper (`### Patch Changes` → `#### Patch Changes`).
 *
 * Version order: take the order from the package with the most recent
 * release (the one whose top version is highest by semver). Any extra
 * versions found only in other packages are appended in semver-descending
 * order at the end.
 */
function syncRootChangelog() {
  const pkgsDir = "packages";
  const pkgDirs = readdirSync(pkgsDir).filter((name) => {
    const p = join(pkgsDir, name);
    return statSync(p).isDirectory() && existsSync(join(p, "CHANGELOG.md"));
  });

  // { pkgName, versions: Map<versionKey, bodyMarkdown>, order: versionKey[] }
  const parsed = pkgDirs.map((dir) => {
    const path = join(pkgsDir, dir, "CHANGELOG.md");
    const raw = readFileSync(path, "utf8");
    let pkgName = dir;
    const titleMatch = raw.match(/^# ([^\n]+)\n/);
    if (titleMatch) pkgName = titleMatch[1].trim();
    return { pkgName, ...parseChangelog(raw) };
  });

  // Pick the canonical version order from whichever package has the highest
  // top version (typically the public CLI). Other packages contribute any
  // additional versions at the tail.
  parsed.sort((a, b) => compareSemver(b.order[0] ?? "0", a.order[0] ?? "0"));
  const seen = new Set();
  const versionOrder = [];
  for (const p of parsed) {
    for (const v of p.order) {
      if (!seen.has(v)) {
        seen.add(v);
        versionOrder.push(v);
      }
    }
  }

  const lines = [
    "# Fusion changelog",
    "",
    "User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.",
    "",
  ];

  for (const version of versionOrder) {
    lines.push(`## ${version}`, "");
    // Sort packages alphabetically within a version for deterministic output.
    const pkgsForVersion = parsed
      .filter((p) => p.versions.has(version))
      .sort((a, b) => a.pkgName.localeCompare(b.pkgName));
    for (const p of pkgsForVersion) {
      const body = p.versions.get(version).trim();
      if (!body) continue;
      lines.push(`### ${p.pkgName}`, "");
      // Bump heading levels by one so package sub-sections nest cleanly.
      const bumped = body.replace(/^(#{1,5}) /gm, (_m, hashes) => `${hashes}# `);
      lines.push(bumped, "");
    }
  }

  writeFileSync("CHANGELOG.md", lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

/**
 * Parse a changeset-format CHANGELOG into { versions, order }.
 * Splits on top-level `## ` headings; the version key is the heading text
 * verbatim (e.g. "0.2.5", or "0.4.0 (pre-release, unpublished)").
 */
function parseChangelog(raw) {
  const versions = new Map();
  const order = [];
  // Strip out the first-line title and any horizontal rules so they don't
  // pollute the first version section.
  const stripped = raw.replace(/^# [^\n]*\n?/, "").replace(/^---\s*$/gm, "");
  const sections = stripped.split(/^## /m).slice(1); // drop pre-first-version preamble
  for (const section of sections) {
    const nl = section.indexOf("\n");
    const key = (nl === -1 ? section : section.slice(0, nl)).trim();
    const body = nl === -1 ? "" : section.slice(nl + 1).trim();
    if (!versions.has(key)) {
      versions.set(key, body);
      order.push(key);
    }
  }
  return { versions, order };
}

/** Compare two semver-ish version strings ("0.2.5", "0.4.0 (pre-release)"). */
function compareSemver(a, b) {
  const pa = parseVersionKey(a);
  const pb = parseVersionKey(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseVersionKey(key) {
  const m = key.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function confirm(prompt) {
  if (AUTO_YES || DRY_RUN) return true;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

// --- Preflight ------------------------------------------------------------

info("Preflight checks…");

const branch = run("git rev-parse --abbrev-ref HEAD", { capture: true }).stdout;
if (branch !== "main") fail(`Must be on 'main' (currently '${branch}').`);

const dirty = run("git status --porcelain", { capture: true }).stdout;
if (dirty) fail("Working tree is not clean. Commit or stash first.");

run("git fetch origin main", { capture: true });
const ahead = run("git rev-list --count origin/main..HEAD", { capture: true }).stdout;
const behind = run("git rev-list --count HEAD..origin/main", { capture: true }).stdout;
if (behind !== "0") fail(`Local main is behind origin/main by ${behind} commit(s). Pull first.`);
if (ahead !== "0") warn(`Local main is ahead of origin/main by ${ahead} commit(s); they will be pushed.`);

const changesets = readdirSync(".changeset").filter(
  (f) => f.endsWith(".md") && f !== "README.md"
);
if (changesets.length === 0) {
  fail("No pending changesets in .changeset/. Run `pnpm changeset` first.");
}
ok(`${changesets.length} pending changeset(s).`);

info("Changeset summary:");
run("pnpm changeset status");

if (!(await confirm("Proceed with version bump, build, publish, and tag?"))) {
  warn("Aborted by user.");
  process.exit(0);
}

// --- Version bump ---------------------------------------------------------

info("Applying changesets (version bump + CHANGELOG)…");
run("pnpm release:version");

info("Updating lockfile…");
run("pnpm install --no-frozen-lockfile");

const cliPkg = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
const version = cliPkg.version;
ok(`New version: ${version}`);

info("Syncing root CHANGELOG.md from packages/cli/CHANGELOG.md…");
syncRootChangelog();
ok("Root CHANGELOG.md updated.");

// --- Build ----------------------------------------------------------------

info("Building all packages…");
run("pnpm build");

// --- Commit ---------------------------------------------------------------

info("Committing version bump…");
run("git add -A");
run(
  `git commit -m "chore(release): v${version}" -m "Version bump via changesets."`,
  { allowFail: true }
);

// --- Publish --------------------------------------------------------------

if (DRY_RUN) {
  warn("--dry-run: skipping npm publish, git push, and tag.");
  info(`Would publish, commit, and tag v${version}.`);
  process.exit(0);
}

info("Publishing to npm (non-private packages only)…");
run("pnpm -r publish --access public --no-git-checks");

// --- Push + tag -----------------------------------------------------------

info("Pushing commit to origin/main…");
run("git push origin main");

info(`Creating and pushing tag v${version}…`);
run(`git tag v${version}`);
run(`git push origin v${version}`);

ok(`Released v${version}. The 'v${version}' tag will trigger release.yml for binary builds.`);
