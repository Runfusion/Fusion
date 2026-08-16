/*
FNXC:DeployPreflight 2026-08-16-22:29 (RUFU-106 resolving RUFU-073 Greptile P1 #1):

The deploy preflight (`scripts/deploy-rufu-073.mjs` `assertMainHasRufu073`) broke on EVERY documented
invocation because it ran `git rev-parse short main` (`short` parsed as a subcommand →
`fatal: ambiguous argument 'short'`), and the `merge-base --is-ancestor` check threw on the
not-ancestor exit code 1 so the intended "RUFU-073 is not on local main" failure branch was dead.

This file is the lightweight Node assertion that pins the FIX: the corrected `--short` flag resolves a
short SHA, and `isAncestorCmd` distinguishes ancestor (exit 0) / not-ancestor (exit 1 -> false, never
throws) / genuine ref error (throws). It builds a throwaway temp git repo so the assertion is
deterministic and never touches the real `REPO` checkout or the live :4040 daemon.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAncestorCmd, shortSha } from "../deploy-rufu-073.mjs";

/** Run git inside the throwaway repo; throw on failure. */
function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr?.trim()}`);
  return res.stdout.trim();
}

/** A throwaway repo with `main` -> commit A, optional feature branch -> commit B on top. */
function makeRepo({ feature = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-rufu-073-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "A"]);
  const mainSha = git(dir, ["rev-parse", "main"]);
  if (!feature) return { dir, mainSha };
  // Move HEAD onto a `feature` branch so `main` stays at commit A while HEAD
  // advances to commit B (main A <-- feature A+B). Without this, commit B would
  // land ON main and the not-ancestor probe would be trivially true.
  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "b.txt"), "b");
  git(dir, ["add", "b.txt"]);
  git(dir, ["commit", "-q", "-m", "B"]);
  const featureSha = git(dir, ["rev-parse", "HEAD"]);
  return { dir, mainSha, featureSha };
}

test("the fixed preflight resolves a short SHA via `--short` (no fatal `short` subcommand)", () => {
  const { dir, mainSha } = makeRepo();
  const short = shortSha("git", "main", dir);
  assert.match(short, /^[0-9a-f]{4,40}$/);
  // It must be a prefix of the full main SHA, proving `--short` (not `short`).
  assert.ok(mainSha.startsWith(short), `${short} should prefix ${mainSha}`);
});

test("isAncestorCmd returns true when the ref IS an ancestor (exit 0)", () => {
  const { dir, mainSha, featureSha } = makeRepo({ feature: true });
  assert.equal(isAncestorCmd("git", mainSha, "main", dir), true);
  assert.equal(isAncestorCmd("git", mainSha, "HEAD", dir), true);
  assert.equal(isAncestorCmd("git", "main", "HEAD", dir), true);
});

test("isAncestorCmd returns false (does NOT throw) when not an ancestor (exit 1)", () => {
  const { dir, featureSha } = makeRepo({ feature: true });
  // `feature` (HEAD) is NOT an ancestor of `main`; git exits 1 -> must be `false`, not a throw.
  assert.equal(isAncestorCmd("git", "HEAD", "main", dir), false);
  assert.equal(isAncestorCmd("git", featureSha, "main", dir), false);
});

test("isAncestorCmd THROWS on a genuine ref error (anything other than exit 0/1)", () => {
  const { dir } = makeRepo();
  // A nonexistent ref name: git exits 128 with an error message, not the exit-1
  // "not an ancestor" case. The helper must propagate that as an error so the
  // operator sees a real failure rather than a silent "not on main".
  assert.throws(() => isAncestorCmd("git", "does-not-exist-missing-ref", "main", dir), /merge-base/);
});
