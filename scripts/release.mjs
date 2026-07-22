#!/usr/bin/env node
// Local release: consume changesets, bump versions, publish to npm, push tag,
// and sync the homebrew tap formula (homebrew-tap/Formula/fusion.rb).
//
// This is a local-machine alternative to the `version.yml` CI workflow.
// Trade-off: CI publishes with npm provenance via OIDC; this script does not.
// If you want provenance, run the workflow manually instead of this script.
//
// Requirements:
//   - clean working tree on the channel's branch (`main` for --channel beta,
//     `release` for stable), up to date with origin
//   - at least one pending changeset in .changeset/
//   - `npm login` already completed (publish uses the active npm token)
//   - real releases require a live operator to type the authorization phrase
//     ("authorized") at an interactive prompt; they cannot run non-interactively.
//     Dry-runs skip this because they make no file/git/npm changes
//
// Usage:
//   pnpm release                  # interactive: review changesets, accept or override version, type the authorization phrase, then confirm before mutation
//   pnpm release --yes            # accept the proposed version, skip the y/N confirmation prompt, but STILL require the typed authorization phrase before mutation
//   pnpm release --dry-run        # preview only; non-interactive by default; no authorization or file/git/npm changes
//   pnpm release --dry-run --interactive
//                                 # preview only, but exercise the version prompt override
//   pnpm release --channel beta   # beta release from `main`: enters changesets pre-mode,
//                                 # versions X.Y.Z-beta.N, publishes npm dist-tag `beta`,
//                                 # GitHub prerelease; skips Homebrew tap + X draft
//   pnpm release --channel stable # stable release from the `release` branch:
//                                 # exits pre-mode if present, publishes dist-tag `latest`,
//                                 # GitHub release marked latest, bumps Homebrew tap
//
//   Without --channel, the script prompts for the channel; the default answer
//   (and the silent default for --yes / non-interactive dry-runs) is BETA.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  evaluateReleaseAuthorization,
  isReleaseAuthorizationPhrase,
  RELEASE_AUTHORIZATION_PHRASE,
} from "./lib/release-authorization-gate.mjs";
import { extractVersionNotes, replaceVersionSection } from "./lib/extract-version-notes.mjs";
import { parseChangesetFile } from "./lib/changeset-schema.mjs";
import { distillReleaseNotes } from "./lib/distill-release-notes.mjs";
import { shouldPromptForVersion } from "./lib/release-prompt-gate.mjs";
import {
  archivePointerLine,
  CHANGELOG_ARCHIVE_CUTOFF,
  CHANGELOG_ARCHIVE_FILE,
  partitionVersionsByCutoff,
} from "./lib/changelog-archive.mjs";
import {
  buildRootChangelogLines,
  collectDistilledBodies,
  normalizeChangelogLines,
  parseChangelog,
} from "./lib/changelog-sync.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv);
/*
 * FNXC:ReleaseScript 2026-06-14-23:08:
 * `--dry-run` must not read stdin in the default agent-shell path; `--interactive` is the explicit maintainer override for prompt coverage while preserving real-release prompts.
 */
const DRY_RUN = args.has("--dry-run");
const AUTO_YES = args.has("--yes") || args.has("-y");
const INTERACTIVE = args.has("--interactive");

/*
 * FNXC:UpdateChannels 2026-07-19-13:20:
 * Two release tracks (see docs/plans/2026-07-19-001-beta-stable-release-tracks-plan.md):
 * - `--channel beta` runs on `main`, uses changesets pre-mode (auto `pre enter beta`),
 *   publishes to the npm `beta` dist-tag, tags vX.Y.Z-beta.N, and creates a GitHub
 *   PRERELEASE. Homebrew tap and the X draft are stable-only and skipped.
 * - `--channel stable` runs on the long-lived `release` branch, exits
 *   pre-mode if `.changeset/pre.json` was merged in from main, publishes to `latest`,
 *   marks the GitHub Release latest, and bumps the Homebrew tap. After a stable
 *   release the operator back-merges `release` into `main` (commands are printed).
 * The publish command ALWAYS passes an explicit `--tag`: a beta accidentally landing
 * on `latest` is the one unrecoverable-embarrassing failure of this scheme.
 */
const channelFlagIndex = argv.indexOf("--channel");
let CHANNEL = channelFlagIndex !== -1 ? argv[channelFlagIndex + 1] : null;
if (CHANNEL !== null && CHANNEL !== "stable" && CHANNEL !== "beta") {
  console.error(`✗ Invalid --channel '${CHANNEL ?? ""}'. Valid channels: stable, beta.`);
  process.exit(1);
}

/*
 * FNXC:UpdateChannels 2026-07-19-14:30:
 * Without an explicit --channel, the operator is prompted to pick one, and the
 * default is BETA: day-to-day releases are betas cut from main, while stable
 * promotions are deliberate (release branch) and must be chosen explicitly
 * (answer "stable" or pass --channel stable). The prompt obeys the same gate
 * as the version prompt (shouldPromptForVersion): non-interactive dry-runs and
 * --yes runs never read stdin and silently default to beta.
 */
if (CHANNEL === null) {
  if (shouldPromptForVersion({ dryRun: DRY_RUN, autoYes: AUTO_YES, interactive: INTERACTIVE })) {
    while (true) {
      const answer = (await ask("Release channel — beta or stable? [beta]: ")).toLowerCase();
      if (answer === "" || answer === "beta" || answer === "b") {
        CHANNEL = "beta";
        break;
      }
      if (answer === "stable" || answer === "s") {
        CHANNEL = "stable";
        break;
      }
      console.log(`  Not a channel: '${answer}'. Answer 'beta' or 'stable'.`);
    }
  } else {
    CHANNEL = "beta";
    console.log("No --channel given; defaulting to the beta channel. Pass --channel stable for a stable release.");
  }
}

const IS_BETA = CHANNEL === "beta";
const RELEASE_BRANCH = IS_BETA ? "main" : "release";
const NPM_DIST_TAG = IS_BETA ? "beta" : "latest";
const PRE_JSON_PATH = join(".changeset", "pre.json");

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
 * Rewrite the repo-root changelogs by aggregating every
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
 *
 * FNXC:ReleaseChangelog 2026-07-12-00:00:
 * The root CHANGELOG.md is regenerated during every release, so the archive prune must happen in this generator instead of as a manual docs edit.
 * Keep versions greater than or equal to the archive cutoff in CHANGELOG.md, and write older versions to CHANGELOG-archive.md so the split survives the next release sync.
 *
 * FNXC:ReleaseChangelog 2026-07-13-22:55:
 * Cutoff is CHANGELOG_ARCHIVE_CUTOFF (currently 0.60.0) from scripts/lib/changelog-archive.mjs.
 *
 * FNXC:ReleaseChangelog 2026-07-21-20:22:
 * Preserve already-distilled version bodies from the existing root CHANGELOG.md
 * (and archive) when regenerating. Distillation only rewrites the current
 * version; without this, every prior release loses its Highlights/New/Fixed
 * summary on the next release sync and falls back to the raw package aggregate.
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

  // Prefer already-distilled bodies so historical releases keep their summary.
  const existingCurrent = existsSync("CHANGELOG.md")
    ? readFileSync("CHANGELOG.md", "utf8")
    : "";
  const existingArchive = existsSync(CHANGELOG_ARCHIVE_FILE)
    ? readFileSync(CHANGELOG_ARCHIVE_FILE, "utf8")
    : "";
  const preservedBodies = collectDistilledBodies([existingCurrent, existingArchive]);

  const { current, archived } = partitionVersionsByCutoff(versionOrder);
  const currentLines = buildRootChangelogLines({
    title: "# Fusion changelog",
    banner: "User-facing release notes aggregated across all packages. This file is auto-synced from each `packages/*/CHANGELOG.md` by `scripts/release.mjs` — do not edit by hand.",
    parsed,
    versionOrder: current,
    preservedBodies,
  });

  if (archived.length > 0) {
    currentLines.push(archivePointerLine(), "");
  }

  const archiveLines = buildRootChangelogLines({
    title: "# Fusion changelog archive",
    banner: `Archived release notes before ${CHANGELOG_ARCHIVE_CUTOFF}. This file is auto-synced from each \`packages/*/CHANGELOG.md\` by \`scripts/release.mjs\` — do not edit by hand.`,
    parsed,
    versionOrder: archived,
    preservedBodies,
  });

  writeFileSync("CHANGELOG.md", normalizeChangelogLines(currentLines));
  writeFileSync(CHANGELOG_ARCHIVE_FILE, normalizeChangelogLines(archiveLines));
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
  // FNXC:UpdateChannels 2026-07-19-15:10: the tap clone is gitignored and only
  // exists in the primary checkout. Assisted promotion runs this script from a
  // temporary worktree and passes the primary checkout's tap path via
  // FUSION_HOMEBREW_TAP_DIR so stable releases still bump the formula.
  const tapDir = process.env.FUSION_HOMEBREW_TAP_DIR || "homebrew-tap";
  const formulaPath = join(tapDir, "Formula", "fusion.rb");
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
  const tapCwd = tapDir;
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

// --- Stable promotion from main --------------------------------------------

/*
 * FNXC:UpdateChannels 2026-07-19-15:10:
 * Choosing the stable channel while on `main` triggers assisted promotion
 * instead of a hard fail. The operator picks a commit to promote (default:
 * the newest v*-beta* tag reachable from HEAD — promotion blesses a tested
 * beta, not whatever main drifted to), the script verifies `release`
 * fast-forwards to it, then creates a TEMPORARY git worktree on `release` and
 * re-runs itself there with --channel stable. The primary checkout never
 * leaves `main` (repo standing rule: branch work happens in worktrees).
 * The tap clone lives at <primary-root>/homebrew-tap and is gitignored, so it
 * does not exist inside the temp worktree — its path is handed to the child
 * via FUSION_HOMEBREW_TAP_DIR so the stable tap bump still works.
 * Dry-runs stop after reporting the promotion plan: creating the worktree
 * would move the local `release` ref, and dry-run must mutate nothing.
 */
if (!IS_BETA && run("git rev-parse --abbrev-ref HEAD", { capture: true }).stdout === "main") {
  info("Stable release requested from 'main' — starting assisted promotion to the 'release' branch.");

  const latestBetaTag = run("git tag --list 'v*-beta*' --merged HEAD --sort=-v:refname", { capture: true })
    .stdout.split("\n")[0]?.trim() ?? "";
  let promoteTarget = latestBetaTag;
  if (!promoteTarget) {
    warn("No v*-beta* tag is reachable from HEAD; defaulting to HEAD (promoting an untested tip — prefer promoting a beta tag).");
    promoteTarget = "HEAD";
  }

  if (shouldPromptForVersion({ dryRun: DRY_RUN, autoYes: AUTO_YES, interactive: INTERACTIVE })) {
    const answer = await ask(`Promote which commit/tag to 'release'? [${promoteTarget}]: `);
    if (answer !== "") promoteTarget = answer;
  } else {
    info(`Non-interactive: promoting ${promoteTarget}.`);
  }

  const targetSha = run(`git rev-parse --verify --quiet ${promoteTarget}^{commit}`, { capture: true, allowFail: true });
  if (targetSha.status !== 0 || !targetSha.stdout) {
    fail(`'${promoteTarget}' does not resolve to a commit.`);
  }
  const promoteSha = targetSha.stdout;

  const originReleaseExists = run("git fetch origin release", { capture: true, allowFail: true }).status === 0;
  const localReleaseExists = run("git show-ref --verify --quiet refs/heads/release", { capture: true, allowFail: true }).status === 0;
  const releaseBase = localReleaseExists ? "release" : originReleaseExists ? "origin/release" : null;
  if (releaseBase) {
    const ff = run(`git merge-base --is-ancestor ${releaseBase} ${promoteSha}`, { capture: true, allowFail: true });
    if (ff.status !== 0) {
      fail(
        `'${releaseBase}' does not fast-forward to ${promoteTarget} (${promoteSha.slice(0, 10)}).\n` +
        "  The release branch has commits (hotfixes?) that are not on main. Merge or rebase manually,\n" +
        "  then run the stable release from a 'release' worktree.",
      );
    }
  } else {
    warn("No 'release' branch exists yet (local or origin); it will be bootstrapped at the promoted commit.");
  }

  if (DRY_RUN) {
    warn("--dry-run: stopping before promotion. No worktree created, no branch moved.");
    info(`Would promote ${promoteTarget} (${promoteSha.slice(0, 10)}) to 'release' via a temporary worktree and run the stable release there.`);
    process.exit(0);
  }

  const promoteDir = mkdtempSync(join(tmpdir(), "fusion-release-promote-"));
  info(`Creating temporary release worktree at ${promoteDir}…`);
  if (localReleaseExists) {
    run(`git worktree add "${promoteDir}" release`);
    run(`git merge --ff-only ${promoteSha}`, { cwd: promoteDir });
  } else if (originReleaseExists) {
    run(`git worktree add -b release "${promoteDir}" origin/release`);
    run(`git merge --ff-only ${promoteSha}`, { cwd: promoteDir });
  } else {
    run(`git worktree add -b release "${promoteDir}" ${promoteSha}`);
  }

  info("Installing dependencies in the promotion worktree (fresh checkout)…");
  run("pnpm install --prefer-offline", { cwd: promoteDir });

  info("Re-running the release inside the promotion worktree (authorization prompts continue there)…");
  const passThroughArgs = [
    join("scripts", "release.mjs"),
    "--channel", "stable",
    ...(AUTO_YES ? ["--yes"] : []),
    ...(INTERACTIVE ? ["--interactive"] : []),
  ];
  const child = spawnSync(process.execPath, passThroughArgs, {
    cwd: promoteDir,
    stdio: "inherit",
    env: { ...process.env, FUSION_HOMEBREW_TAP_DIR: resolve("homebrew-tap") },
  });

  if (child.status === 0) {
    // node_modules makes the worktree "dirty" to git; --force is required and safe here.
    const removed = run(`git worktree remove --force "${promoteDir}"`, { capture: true, allowFail: true });
    if (removed.status !== 0) {
      warn(`Could not remove promotion worktree; clean up manually: git worktree remove --force "${promoteDir}"`);
    } else {
      ok("Promotion worktree removed.");
    }
    info("Reminder: back-merge 'release' into 'main' from this checkout (commands were printed above).");
  } else {
    warn(`Stable release in the promotion worktree exited with status ${child.status ?? "unknown"}.`);
    warn(`Worktree kept for inspection: ${promoteDir}`);
  }
  process.exit(child.status ?? 1);
}

// --- Preflight ------------------------------------------------------------

info(`Preflight checks (${CHANNEL} channel)…`);

const branch = run("git rev-parse --abbrev-ref HEAD", { capture: true }).stdout;
if (branch !== RELEASE_BRANCH) {
  if (IS_BETA) {
    fail(`Beta releases are cut from 'main' (currently '${branch}').`);
  }
  fail(
    `Stable releases are cut from the '${RELEASE_BRANCH}' branch (currently '${branch}').\n` +
    `  To promote: merge/fast-forward '${RELEASE_BRANCH}' to the chosen beta commit on main, then release there.\n` +
    `  First-time bootstrap: git branch ${RELEASE_BRANCH} main && git push -u origin ${RELEASE_BRANCH}\n` +
    `  For a beta from main, run: pnpm release --channel beta`,
  );
}

const dirty = run("git status --porcelain", { capture: true }).stdout;
if (dirty) fail("Working tree is not clean. Commit or stash first.");

// The remote release branch may not exist yet on the first stable promotion;
// fall back to a warning and let the final push create it with -u.
const fetchRemote = run(`git fetch origin ${RELEASE_BRANCH}`, { capture: true, allowFail: true });
let remoteBranchExists = fetchRemote.status === 0;
if (remoteBranchExists) {
  const ahead = run(`git rev-list --count origin/${RELEASE_BRANCH}..HEAD`, { capture: true }).stdout;
  const behind = run(`git rev-list --count HEAD..origin/${RELEASE_BRANCH}`, { capture: true }).stdout;
  if (behind !== "0") fail(`Local ${RELEASE_BRANCH} is behind origin/${RELEASE_BRANCH} by ${behind} commit(s). Pull first.`);
  if (ahead !== "0") warn(`Local ${RELEASE_BRANCH} is ahead of origin/${RELEASE_BRANCH} by ${ahead} commit(s); they will be pushed.`);
} else {
  warn(`origin/${RELEASE_BRANCH} does not exist yet; the release push will create it.`);
}

/*
 * FNXC:UpdateChannels 2026-07-19-13:20:
 * Changesets pre-mode is the version engine for the beta track. In pre-mode,
 * `changeset version` bumps to X.Y.Z-beta.N while PRESERVING the changeset
 * .md files (recording them in pre.json), so the eventual stable release on
 * the `release` branch aggregates every changeset across all betas after
 * `changeset pre exit`. Beta auto-enters pre-mode here; stable auto-exits.
 * Dry-runs revert whichever pre-mode mutation they made before exiting.
 */
let preModeMutation = "none"; // "entered" | "exited" | "none"
const preJsonExists = () => existsSync(PRE_JSON_PATH) && JSON.parse(readFileSync(PRE_JSON_PATH, "utf8")).mode === "pre";
if (IS_BETA) {
  if (!preJsonExists()) {
    info("Entering changesets pre-mode (beta)…");
    run("pnpm changeset pre enter beta");
    preModeMutation = "entered";
  }
} else if (existsSync(PRE_JSON_PATH) && preJsonExists()) {
  info("Exiting changesets pre-mode (promoting to stable)…");
  run("pnpm changeset pre exit");
  preModeMutation = "exited";
}

function revertDryRunPreModeMutation() {
  if (preModeMutation === "entered") {
    // `pre enter` only creates/rewrites pre.json; restore or remove it.
    const tracked = run(`git ls-files --error-unmatch ${PRE_JSON_PATH}`, { capture: true, allowFail: true });
    if (tracked.status === 0) {
      run(`git checkout -- ${PRE_JSON_PATH}`);
    } else {
      try { unlinkSync(PRE_JSON_PATH); } catch { /* best-effort */ }
    }
  } else if (preModeMutation === "exited") {
    run(`git checkout -- ${PRE_JSON_PATH}`);
  }
}

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
  info(`Would release v${chosenVersion} on the ${CHANNEL} channel (npm dist-tag '${NPM_DIST_TAG}'${IS_BETA ? ", GitHub prerelease" : ", GitHub latest + Homebrew tap bump"}) with ${releases.length} package(s) bumped.`);
  /*
   * FNXC:ReleaseScript 2026-07-13-15:25:
   * Dry-run previews the LLM-authored Highlights + X draft (falls back to
   * deterministic if no model is reachable) so operators can review the post
   * without authorizing a real publish.
   */
  const dryEntries = changesetSummaries.map(({ file }) => {
    const raw = readFileSync(join(".changeset", file), "utf8");
    return parseChangesetFile(raw).parsed;
  }).filter(Boolean);
  info("Distilling release notes with Claude (sonnet; soft fallback if unavailable)…");
  const dryDistilled = await distillReleaseNotes(dryEntries, chosenVersion);
  console.log("");
  console.log(color(36, "─── Draft post for X (preview) ───"));
  console.log(dryDistilled.tweet);
  console.log(color(90, `(${dryDistilled.tweet.length}/280 chars; source: ${dryDistilled.source})`));
  console.log(color(36, "──────────────────────────────────"));
  // A dry-run must leave the tree exactly as it found it, including the
  // pre-mode enter/exit performed to compute the channel's release plan.
  revertDryRunPreModeMutation();
  process.exit(0);
}

/*
 * FNXC:ReleaseScript 2026-07-08-11:20:
 * FN-6469 showed `main`-branch preflight is bypassable by cloning a clean `main`. A real release now requires a live human to type the authorization phrase at an interactive prompt before any version bump, publish, push, tag, GitHub Release, or Homebrew tap mutation can begin. This replaces the removed `FUSION_RELEASE_AUTHORIZED` env signal, which was self-grantable and leaked into non-interactive shells. `--yes` does not bypass this prompt; a non-interactive shell is blocked outright. Dry-run exits above so agents can still inspect release plans without authorization.
 */
const releaseAuthorization = evaluateReleaseAuthorization({
  dryRun: DRY_RUN,
  stdinIsTTY: process.stdin.isTTY === true,
});
if (releaseAuthorization.mode === "blocked") {
  fail(
    `${releaseAuthorization.reason ?? "Release is not authorized."}\n` +
    "Releases are not agent-initiable and cannot run non-interactively.",
  );
}
if (releaseAuthorization.mode === "requires-confirmation") {
  const typed = await ask(
    `Type "${RELEASE_AUTHORIZATION_PHRASE}" to authorize this real release (build, publish, tag): `,
  );
  if (!isReleaseAuthorizationPhrase(typed)) {
    fail(
      `Authorization phrase not entered ("${RELEASE_AUTHORIZATION_PHRASE}" required); aborted before version bump, publish, push, or tag.`,
    );
  }
}

if (!(await confirm(`Proceed with ${CHANNEL} release v${chosenVersion} (build, publish to npm tag '${NPM_DIST_TAG}', tag)?`))) {
  warn("Aborted by user.");
  process.exit(0);
}

// --- Version bump ---------------------------------------------------------

/*
 * FNXC:Changelog 2026-06-24-16:15:
 * Capture and parse structured changeset entries BEFORE `changeset version`
 * runs — versioning consumes and deletes the .changeset/*.md files.
 * The captured entries feed the post-version distillation step.
 */
const capturedEntries = changesetSummaries.map(({ file }) => {
  const raw = readFileSync(join(".changeset", file), "utf8");
  return parseChangesetFile(raw).parsed;
}).filter(Boolean);

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

/*
 * FNXC:ReleaseScript 2026-07-13-15:45:
 * Claude CLI (`claude -p --model sonnet`) authors Highlights (top 3–5), full
 * notes, and an engagement-oriented X draft ≤280 chars. Soft deterministic
 * fallback only if Claude is unreachable so release never blocks.
 */
info("Distilling release notes with Claude (sonnet; soft fallback if unavailable)…");
const {
  notes: distilledNotes,
  source: distillSource,
  highlights: releaseHighlights,
  tweet: releaseTweet,
} = await distillReleaseNotes(capturedEntries, version);
const changelogBeforeDistill = readFileSync("CHANGELOG.md", "utf8");
const changelogAfterDistill = replaceVersionSection(changelogBeforeDistill, version, distilledNotes);
if (changelogAfterDistill !== changelogBeforeDistill) {
  writeFileSync("CHANGELOG.md", changelogAfterDistill);
  ok(`Root CHANGELOG.md updated with distilled notes (source: ${distillSource}; ${releaseHighlights.length} highlight(s)).`);
} else {
  warn(`Could not locate version section in CHANGELOG.md for distillation; leaving raw aggregate.`);
}

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

/*
 * FNXC:UpdateChannels 2026-07-19-13:20:
 * ALWAYS pass an explicit --tag. Relying on npm's implicit default (`latest`)
 * is how a beta would pollute the stable track for every `fn update` user.
 */
info(`Publishing to npm dist-tag '${NPM_DIST_TAG}' (non-private packages only)…`);
run(`pnpm -r publish --access public --no-git-checks --tag ${NPM_DIST_TAG}`);

// --- Push + tag -----------------------------------------------------------

info(`Pushing commit to origin/${RELEASE_BRANCH}…`);
run(remoteBranchExists ? `git push origin ${RELEASE_BRANCH}` : `git push -u origin ${RELEASE_BRANCH}`);

info(`Creating and pushing tag v${version}…`);
run(`git tag v${version}`);
run(`git push origin v${version}`);

// --- Homebrew tap bump ----------------------------------------------------
// Sync homebrew-tap/Formula/fusion.rb (url + sha256) to the new version so
// `brew install runfusion/tap/fusion` stays in lockstep with npm.
// The tap tracks the STABLE channel only — betas never touch the formula.
if (IS_BETA) {
  info("Beta channel: skipping Homebrew tap bump (tap tracks stable only).");
} else {
  info("Bumping homebrew tap formula…");
  bumpHomebrewTap(version);
}

// --- GitHub Release ------------------------------------------------------

let githubReleaseStatus = "not-created";
const changelogContent = readFileSync("CHANGELOG.md", "utf8");
const releaseNotes = extractVersionNotes(changelogContent, version);
const ghCheck = spawnSync("gh", ["--version"], { stdio: "pipe" });

// Betas are GitHub PRERELEASES; only stable releases carry --latest so the
// desktop stable auto-updater (which follows the GitHub "latest" release) and
// the /releases/latest URL never see a beta.
const ghReleaseTypeFlag = IS_BETA ? "--prerelease" : "--latest";

if (ghCheck.status !== 0) {
  githubReleaseStatus = "missing-gh";
  warn(`⚠ gh CLI not found. Create the GitHub Release manually:\n  gh release create v${version} --title "v${version}" ${ghReleaseTypeFlag}`);
} else {
  let notesFile;
  try {
    const notesDir = mkdtempSync(join(tmpdir(), "fusion-release-notes-"));
    notesFile = join(notesDir, `v${version}-notes.md`);
    writeFileSync(notesFile, `${releaseNotes}\n`, "utf8");

    const ghCreate = spawnSync(
      "gh",
      ["release", "create", `v${version}`, "--title", `v${version}`, "--notes-file", notesFile, ghReleaseTypeFlag],
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
  ok(`Released v${version} (${CHANNEL}). Published to npm tag '${NPM_DIST_TAG}', tag pushed, GitHub ${IS_BETA ? "prerelease" : "Release"} created.`);
} else if (githubReleaseStatus === "missing-gh") {
  ok(`Released v${version} (${CHANNEL}). Published to npm tag '${NPM_DIST_TAG}', tag pushed. GitHub Release skipped (gh CLI not found).`);
} else {
  ok(`Released v${version} (${CHANNEL}). Published to npm tag '${NPM_DIST_TAG}', tag pushed. GitHub Release was not created (see warnings above).`);
}

/*
 * FNXC:UpdateChannels 2026-07-19-13:20:
 * A stable release consumes the changesets + pre.json state on the `release`
 * branch; main must pick that up (consumed changesets, changelogs, version,
 * deleted pre.json) or the next beta double-releases old changesets. The merge
 * can conflict if main moved during promotion, so print the commands instead
 * of force-running them — fail-soft by design.
 */
if (!IS_BETA) {
  console.log("");
  info("Next step — back-merge the release branch into main:");
  console.log(`    git checkout main && git pull origin main`);
  console.log(`    git merge ${RELEASE_BRANCH} -m "chore(release): back-merge v${version} from ${RELEASE_BRANCH}"`);
  console.log(`    git push origin main`);
  console.log(color(90, "  (The next beta on main will re-enter pre-mode automatically.)"));
}

/*
 * FNXC:ReleaseScript 2026-07-13-15:25:
 * After a successful publish/tag, print the LLM-authored X draft (≤280 chars)
 * produced during distillation so the operator can copy-paste to X.
 * FNXC:UpdateChannels 2026-07-19-13:20: stable-only — betas are not announced.
 */
if (!IS_BETA) {
  console.log("");
  console.log(color(36, "─── Draft post for X (copy-paste) ───"));
  console.log(releaseTweet);
  console.log(color(90, `(${releaseTweet.length}/280 chars; source: ${distillSource})`));
  console.log(color(36, "─────────────────────────────────────"));
}

