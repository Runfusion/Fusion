#!/usr/bin/env node
/*
 * FNXC:Changelog 2026-06-24-17:30:
 * Wrapper that runs the CI distillation step after `changeset version` and
 * `sync-workspace-version` have bumped versions. Auto-detects the new version
 * from packages/cli/package.json. Chained into the `release:version` script
 * so both local and CI versioning flows get distilled notes.
 *
 * Degrades gracefully: if no CHANGELOG.md exists or the version section
 * cannot be found, it logs and exits 0 (does not block the release).
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const cliPkg = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
const version = cliPkg.version;

if (!version) {
  console.log("[distill] No version found in packages/cli/package.json; skipping.");
  process.exit(0);
}

try {
  execSync(`node scripts/ci-distill-release-notes.mjs --version "${version}"`, {
    stdio: "inherit",
  });
} catch {
  // Distillation failure should never block a release.
  console.log("[distill] Distillation failed; release continues with raw CHANGELOG.");
  process.exit(0);
}
