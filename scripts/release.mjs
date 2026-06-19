#!/usr/bin/env node
// Local release: consume changesets, bump versions, publish to npm, push tag,
// and sync the homebrew tap formula (homebrew-tap/Formula/fusion.rb).
//
// This is a local-machine alternative to the `version.yml` CI workflow.
// Trade-off: CI publishes with npm provenance via OIDC; this script does not.
// If you want provenance, run the workflow manually instead of this script.
//
// Requirements:
//   - clean working tree on `main`, up to date with origin
//   - at least one pending changeset in .changeset/
//   - `npm login` already completed (publish uses the active npm token)
//   - real releases require an operator-held FUSION_RELEASE_AUTHORIZED signal;
//     dry-runs do not require it because they make no file/git/npm changes
//
// Usage:
//   pnpm release                  # interactive: review changesets, accept or override version, confirm, then require operator authorization before mutation
//   pnpm release --yes            # accept the proposed version, skip confirmation prompt, still require operator authorization before mutation
//   pnpm release --dry-run        # preview only; non-interactive by default; no authorization signal or file/git/npm changes
//   pnpm release --dry-run --interactive
//                                 # preview only, but exercise the version prompt override

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { evaluateReleaseAuthorization } from "./lib/release-authorization-gate.mjs";
import { extractVersionNotes } from "./lib/extract-version-notes.mjs";
import { shouldPromptForVersion } from "./lib/release-prompt-gate.mjs";

const args = new Set(process.argv.slice(2));
/*
 * FNXC:ReleaseScript 2026-06-14-23:08:
 * `--dry-run` must not read stdin in the default agent-shell path; `--interactive` is the explicit maintainer override for prompt coverage while preserving real-release prompts.
 */
const DRY_RUN = args.has("--dry-run");
const AUTO_YES = args.has("--yes") || args.has("-y");
const INTERACTIVE = args.has("--interactive");

const color = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const info = (s) => console.log(color(36, "▶ ") + s);
const ok = (s) => console.log(color(32, "✓ ") + s);
const warn = (s) => console.log(color(33, "! ") + s);
const fail = (s) => {
  console.error(color(31, "✗ ") + s);
  process.exit(1);
};

function run(cmd, { capture = false, allowFail = false, cwd } = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    cwd,
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
  if (AUTO_YES) return true;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

async function ask(prompt) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Run `pnpm changeset status --output` to compute the proposed release plan
 * without applying it. Returns { proposedVersion, releases } where releases
 * is the bumped public packages list.
 *
 * The repo uses a single "fixed" group, so every bumped public package
 * shares one new version — we surface that as the canonical proposedVersion.
 */
function computeReleasePlan() {
  const dir = mkdtempSync(join(tmpdir(), "fusion-release-"));
  const out = join(dir, "plan.json");
  const r = spawnSync("pnpm", ["changeset", "status", "--output", out], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status !== 0) {
    fail(`Failed to compute release plan:\n${r.stderr || r.stdout}`);
  }
  const plan = JSON.parse(readFileSync(out, "utf8"));
  try { unlinkSync(out); } catch { /* tmp cleanup is best-effort */ }

  const bumpedReleases = (plan.releases || []).filter((rel) => rel.type !== "none");
  if (bumpedReleases.length === 0) {
    fail("Release plan contains no bumps. All changesets resolved to 'none'.");
  }

  // All public packages share a version (changeset config "fixed"); pick the
  // first non-none release's newVersion as canonical. Sanity-check below.
  const proposedVersion = bumpedReleases[0].newVersion;
  const mismatched = bumpedReleases.filter(
    (rel) => rel.newVersion !== proposedVersion && !rel.private,
  );
  if (mismatched.length > 0) {
    warn("Bumped packages have differing versions; using the first as canonical:");
    for (const rel of mismatched) console.log(`    ${rel.name} → ${rel.newVersion}`);
  }
  return { proposedVersion, releases: bumpedReleases, plan };
}

/**
 * Read the changeset markdown files in `.changeset/` and return [{ file, bump, summary }].
 * `bump` is the highest bump declared in that file's frontmatter.
 */
function readChangesetSummaries() {
  const files = readdirSync(".changeset").filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );
  return files.map((file) => {
    const raw = readFileSync(join(".changeset", file), "utf8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let bump = "patch";
    let summary = raw.trim();
    if (fm) {
      const bumps = [...fm[1].matchAll(/:\s*(major|minor|patch)/g)].map((m) => m[1]);
      const order = { major: 3, minor: 2, patch: 1 };
      bump = bumps.reduce((a, b) => (order[b] > order[a] ? b : a), "patch");
      summary = fm[2].trim();
    }
    // Keep the summary tight for terminal display.
    const firstLine = summary.split("\n").find((l) => l.trim()) ?? "(no summary)";
    return { file, bump, summary: firstLine.trim() };
  });
}

/**
 * If the user picked a version different from what changesets generated,
 * patch every bumped package's package.json + CHANGELOG.md heading so the
 * commit, npm publish, and tag all use the chosen version.
 */
function overrideVersion(releases, proposedVersion, chosenVersion) {
  if (proposedVersion === chosenVersion) return;
  // Only rewrite packages that resolved to the canonical proposed version
  // (i.e. members of the "fixed" group). Other bumped packages have their
  // own independent versions (e.g. plugin examples) and must be left alone.
  const targets = releases.filter((rel) => rel.newVersion === proposedVersion);
  info(`Rewriting ${targets.length} package(s) to v${chosenVersion}…`);
  for (const rel of targets) {
    const dir = findPackageDir(rel.name);
    if (!dir) {
      warn(`  Could not locate package directory for ${rel.name}; skipping.`);
      continue;
    }
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.version = chosenVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    const changelogPath = join(dir, "CHANGELOG.md");
    if (existsSync(changelogPath)) {
      const raw = readFileSync(changelogPath, "utf8");
      // Replace only the most recent (top) version heading to avoid touching history.
      const patched = raw.replace(
        new RegExp(`^## ${escapeRegex(proposedVersion)}\\b`, "m"),
        `## ${chosenVersion}`,
      );
      writeFileSync(changelogPath, patched);
    }
  }
  ok(`Version override applied: ${proposedVersion} → ${chosenVersion}`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pack @runfusion/fusion and runfusion.ai, install them into a clean temp dir
 * with plain `npm` (mimicking the `npx runfusion.ai` install path), and invoke
 * the bin with --help. Throws via fail() on any error.
 *
 * Why this exists: the workspace install hides missing-from-published-deps
 * bugs because pnpm hoists devDeps. Issue #33 (dockerode missing in published
 * dependencies) shipped because no check ever ran against a real npm install.
 */
function runReleaseSmoke() {
  const repoRoot = resolve(".");
  const fusionDir = join(repoRoot, "packages", "cli");
  const aliasDir = join(repoRoot, "packages", "cli-alias");
  const smokeDir = mkdtempSync(join(tmpdir(), "fusion-smoke-"));
  const packDir = join(smokeDir, "tarballs");
  spawnSync("mkdir", ["-p", packDir]);

  const packOne = (cwd) => {
    const r = spawnSync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (r.status !== 0) {
      cleanupSmoke(smokeDir);
      fail(`pnpm pack failed in ${cwd}:\n${r.stderr || r.stdout}`);
    }
  };
  packOne(fusionDir);
  packOne(aliasDir);

  const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  const fusionTarball = tarballs.find((f) => f.startsWith("runfusion-fusion-"));
  const aliasTarball = tarballs.find((f) => f.startsWith("runfusion.ai-"));
  if (!fusionTarball || !aliasTarball) {
    cleanupSmoke(smokeDir);
    fail(`Could not find packed tarballs in ${packDir}: ${tarballs.join(", ")}`);
  }
  const fusionTarballPath = join(packDir, fusionTarball);
  const aliasTarballPath = join(packDir, aliasTarball);

  const installDir = join(smokeDir, "install");
  spawnSync("mkdir", ["-p", installDir]);
  // Override @runfusion/fusion to the local tarball — without this, npm tries
  // to fetch the version-matching tarball from the registry (which we haven't
  // published yet).
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify(
      {
        name: "fusion-smoke-test",
        version: "0.0.0",
        private: true,
        overrides: { "@runfusion/fusion": `file:${fusionTarballPath}` },
      },
      null,
      2,
    ),
  );

  const npmInstall = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", aliasTarballPath],
    { cwd: installDir, stdio: "pipe", encoding: "utf8" },
  );
  if (npmInstall.status !== 0) {
    cleanupSmoke(smokeDir);
    fail(`npm install of packed tarballs failed:\n${npmInstall.stderr || npmInstall.stdout}`);
  }

  // Invoke the bin via the alias entry. Exercises the same import graph as
  // `npx runfusion.ai` and surfaces ERR_MODULE_NOT_FOUND for any externalized
  // module that isn't a real published dep (the dockerode bug).
  const aliasBin = join(installDir, "node_modules", "runfusion.ai", "index.js");
  if (!existsSync(aliasBin)) {
    cleanupSmoke(smokeDir);
    fail(`Smoke install missing alias bin at ${aliasBin}`);
  }
  const invoke = spawnSync("node", [aliasBin, "--help"], {
    cwd: installDir,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 30_000,
  });
  if (invoke.status !== 0) {
    cleanupSmoke(smokeDir);
    fail(
      `Packed bin failed to start (exit ${invoke.status}):\n--- stdout ---\n${invoke.stdout}\n--- stderr ---\n${invoke.stderr}`,
    );
  }

  cleanupSmoke(smokeDir);
}

function cleanupSmoke(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * After the npm publish + tag push, sync `homebrew-tap/Formula/fusion.rb` to
 * the new version: rewrite the tarball `url` and recompute its sha256 from the
 * registry, then commit and push the tap formula update on top of the release
 * commit. The npm registry can take a few seconds to surface a freshly
 * published tarball, so we retry briefly. Failures are non-fatal — the user
 * can re-run the bump manually if needed; the release itself is already out.
 */
function bumpHomebrewTap(version) {
  const formulaPath = join("homebrew-tap", "Formula", "fusion.rb");
  if (!existsSync(formulaPath)) {
    warn(`Homebrew tap formula not found at ${formulaPath} — skipping tap bump.`);
    return;
  }

  const tarballUrl = `https://registry.npmjs.org/@runfusion/fusion/-/fusion-${version}.tgz`;
  info(`Fetching ${tarballUrl} to compute sha256…`);

  let sha256;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = spawnSync(
      "bash",
      ["-c", `set -o pipefail; curl -sfL "${tarballUrl}" | shasum -a 256 | awk '{print $1}'`],
      { stdio: "pipe", encoding: "utf8" }
    );
    const out = (r.stdout || "").trim();
    if (r.status === 0 && /^[0-9a-f]{64}$/.test(out)) {
      sha256 = out;
      break;
    }
    if (attempt < maxAttempts) {
      warn(`  npm registry not ready (attempt ${attempt}/${maxAttempts}); retrying in 5s…`);
      spawnSync("sleep", ["5"]);
    }
  }
  if (!sha256) {
    warn(`Could not fetch sha256 for ${tarballUrl} after ${maxAttempts} attempts. Update ${formulaPath} manually.`);
    return;
  }

  const raw = readFileSync(formulaPath, "utf8");
  const patched = raw
    .replace(/^(\s*url\s+)"[^"]*"/m, `$1"${tarballUrl}"`)
    .replace(/^(\s*sha256\s+)"[0-9a-f]{64}"/m, `$1"${sha256}"`);
  if (patched === raw) {
    warn(`Formula at ${formulaPath} unchanged — could not match url/sha256 lines (already at v${version}?). No tap commit created.`);
    return;
  }
  writeFileSync(formulaPath, patched);

  // homebrew-tap is a sibling clone (gitignored in this repo) with its own git
  // history; run git inside that working tree, not the main repo.
  const tapCwd = "homebrew-tap";
  run(`git add Formula/fusion.rb`, { cwd: tapCwd });
  const commit = run(
    `git commit -m "chore(tap): bump fusion to v${version}" -m "Auto-bumped by scripts/release.mjs after npm publish."`,
    { allowFail: true, capture: true, cwd: tapCwd }
  );
  if (commit.status !== 0) {
    warn(`Tap commit failed (working tree may already be clean). Inspect ${formulaPath} manually.`);
    return;
  }

  const push = run("git push origin main", { allowFail: true, capture: true, cwd: tapCwd });
  if (push.status !== 0) {
    warn(`Failed to push tap bump commit to origin/main. Run \`git push origin main\` manually.`);
    return;
  }
  ok(`Homebrew tap formula bumped to v${version} (sha256 ${sha256.slice(0, 12)}…) and pushed.`);
}

function findPackageDir(name) {
  // Most packages live under packages/<basename>; do an exact match on package.json name.
  const roots = ["packages"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const p = join(root, entry, "package.json");
      if (!existsSync(p)) continue;
      try {
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (pkg.name === name) return join(root, entry);
      } catch { /* skip unreadable/broken package.json */ }
    }
  }
  return null;
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

const changesetSummaries = readChangesetSummaries();
if (changesetSummaries.length === 0) {
  fail("No pending changesets in .changeset/. Run `pnpm changeset` first.");
}
ok(`${changesetSummaries.length} pending changeset(s):`);
for (const cs of changesetSummaries) {
  console.log(`    ${color(33, `[${cs.bump}]`)} ${cs.summary}  ${color(90, `(${cs.file})`)}`);
}

info("Computing proposed release plan…");
const { proposedVersion, releases } = computeReleasePlan();
const currentVersion = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version;

console.log("");
console.log(`  Current version : ${color(90, currentVersion)}`);
console.log(`  Proposed version: ${color(32, proposedVersion)}`);
console.log(`  Bumped packages : ${releases.map((r) => r.name).join(", ")}`);
console.log("");

let chosenVersion = proposedVersion;
if (shouldPromptForVersion({ dryRun: DRY_RUN, autoYes: AUTO_YES, interactive: INTERACTIVE })) {
  while (true) {
    const answer = await ask(`Release version [${proposedVersion}]: `);
    if (answer === "") break;
    if (!SEMVER_RE.test(answer)) {
      warn(`Not a valid semver string: '${answer}'. Try again.`);
      continue;
    }
    chosenVersion = answer;
    break;
  }
}

if (chosenVersion !== proposedVersion) {
  warn(`Overriding changeset-proposed version: ${proposedVersion} → ${chosenVersion}`);
}

if (DRY_RUN) {
  warn("--dry-run: stopping before version bump. No files modified, no commit, no publish, no tag.");
  info(`Would release v${chosenVersion} (${releases.length} package(s) bumped).`);
  process.exit(0);
}

/*
 * FNXC:ReleaseScript 2026-06-15-02:45:
 * FN-6469 showed `main`-branch preflight is bypassable by cloning a clean `main`; require an out-of-tree operator-held authorization signal before any version bump, publish, push, tag, GitHub Release, or Homebrew tap mutation can begin.
 * Dry-run exits above so agents can still inspect release plans without the signal.
 */
const releaseAuthorization = evaluateReleaseAuthorization({
  dryRun: DRY_RUN,
  env: process.env,
  stdinIsTTY: process.stdin.isTTY === true,
});
if (!releaseAuthorization.authorized) {
  fail(
    `${releaseAuthorization.reason ?? "Release is not authorized."}\n` +
    "Releases are not agent-initiable. A human operator must provide the operator-held FUSION_RELEASE_AUTHORIZED signal from outside the repository before invoking a real release.",
  );
}

if (!(await confirm(`Proceed with release v${chosenVersion} (build, publish, tag)?`))) {
  warn("Aborted by user.");
  process.exit(0);
}

// --- Version bump ---------------------------------------------------------

info("Applying changesets (version bump + CHANGELOG)…");
run("pnpm release:version");

overrideVersion(releases, proposedVersion, chosenVersion);
run("node scripts/sync-workspace-version.mjs");

info("Updating lockfile…");
run("pnpm install --no-frozen-lockfile");

const cliPkg = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
const version = cliPkg.version;
if (version !== chosenVersion) {
  fail(`Post-bump version mismatch: package reports ${version}, expected ${chosenVersion}.`);
}
const workspacePkg = JSON.parse(readFileSync("package.json", "utf8"));
if (workspacePkg.version !== chosenVersion) {
  fail(`Post-bump workspace version mismatch: package.json reports ${workspacePkg.version}, expected ${chosenVersion}.`);
}
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

// --- Pre-publish smoke ----------------------------------------------------
// Pack the public CLI tarballs, install them with plain `npm` into a clean
// temp dir, and exercise the bin to verify a real `npx runfusion.ai` install
// would succeed. Catches missing-published-deps (dockerode-class), missing
// files-glob entries, broken bin shebangs, etc. that the workspace install
// masks via pnpm hoisting.

info("Running pre-publish smoke (pack + clean-install + invoke bin)…");
runReleaseSmoke();
ok("Pre-publish smoke passed.");

// --- Publish --------------------------------------------------------------

info("Publishing to npm (non-private packages only)…");
run("pnpm -r publish --access public --no-git-checks");

// --- Push + tag -----------------------------------------------------------

info("Pushing commit to origin/main…");
run("git push origin main");

info(`Creating and pushing tag v${version}…`);
run(`git tag v${version}`);
run(`git push origin v${version}`);

// --- Homebrew tap bump ----------------------------------------------------
// Sync homebrew-tap/Formula/fusion.rb (url + sha256) to the new version so
// `brew install runfusion/tap/fusion` stays in lockstep with npm.
info("Bumping homebrew tap formula…");
bumpHomebrewTap(version);

// --- GitHub Release ------------------------------------------------------

let githubReleaseStatus = "not-created";
const changelogContent = readFileSync("CHANGELOG.md", "utf8");
const releaseNotes = extractVersionNotes(changelogContent, version);
const ghCheck = spawnSync("gh", ["--version"], { stdio: "pipe" });

if (ghCheck.status !== 0) {
  githubReleaseStatus = "missing-gh";
  warn(`⚠ gh CLI not found. Create the GitHub Release manually:\n  gh release create v${version} --title "v${version}" --latest`);
} else {
  let notesFile;
  try {
    const notesDir = mkdtempSync(join(tmpdir(), "fusion-release-notes-"));
    notesFile = join(notesDir, `v${version}-notes.md`);
    writeFileSync(notesFile, `${releaseNotes}\n`, "utf8");

    const ghCreate = spawnSync(
      "gh",
      ["release", "create", `v${version}`, "--title", `v${version}`, "--notes-file", notesFile, "--latest"],
      { stdio: "inherit" }
    );

    if (ghCreate.status !== 0) {
      warn(`GitHub Release creation failed for v${version}. You can retry manually with gh release create.`);
    } else {
      githubReleaseStatus = "created";
    }
  } catch (error) {
    warn(`GitHub Release creation failed for v${version}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (notesFile && existsSync(notesFile)) {
      unlinkSync(notesFile);
    }
  }
}

if (githubReleaseStatus === "created") {
  ok(`Released v${version}. Published to npm, tag pushed, GitHub Release created.`);
} else if (githubReleaseStatus === "missing-gh") {
  ok(`Released v${version}. Published to npm, tag pushed. GitHub Release skipped (gh CLI not found).`);
} else {
  ok(`Released v${version}. Published to npm, tag pushed. GitHub Release was not created (see warnings above).`);
}
