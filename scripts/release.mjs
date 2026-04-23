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
import { readFileSync, readdirSync } from "node:fs";
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
