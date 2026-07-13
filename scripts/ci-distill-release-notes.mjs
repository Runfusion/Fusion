#!/usr/bin/env node
/*
 * FNXC:Changelog 2026-06-24-17:00:
 * CI distillation entrypoint. Runs AFTER `changeset version` has consumed
 * the changesets and produced per-package CHANGELOGs, but BEFORE the version
 * PR commit. Reads the root CHANGELOG.md, distills the current version's
 * section from the structured entries, and writes the distilled notes back.
 *
 * When no model is configured (no model secret in CI), it falls back to the
 * deterministic distillation — a model outage never blocks a release.
 *
 * Usage:
 *   node scripts/ci-distill-release-notes.mjs --version <version>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parseChangesetBody } from "./lib/changeset-schema.mjs";
import { distillReleaseNotes } from "./lib/distill-release-notes.mjs";
import { extractVersionNotes, replaceVersionSection } from "./lib/extract-version-notes.mjs";

const args = process.argv.slice(2);
const versionIdx = args.indexOf("--version");
const version = versionIdx > -1 ? args[versionIdx + 1] : null;

if (!version) {
  console.error("Usage: node scripts/ci-distill-release-notes.mjs --version <version>");
  process.exit(1);
}

const CHANGELOG_PATH = "CHANGELOG.md";

if (!existsSync(CHANGELOG_PATH)) {
  console.log(`[ci-distill] No CHANGELOG.md found; skipping distillation.`);
  process.exit(0);
}

/**
 * Extract entries for the current version from the CLI package CHANGELOG.
 * The changesets have already been consumed by `changeset version`, so we
 * read the per-package CHANGELOG to find the version's structured entries.
 */
function extractVersionEntries(ver) {
  const cliChangelogPath = join("packages", "cli", "CHANGELOG.md");
  const entries = [];

  if (!existsSync(cliChangelogPath)) {
    return entries;
  }

  const raw = readFileSync(cliChangelogPath, "utf8");
  const notes = extractVersionNotes(raw, ver);

  for (const line of notes.split(/\r?\n/)) {
    const bulletMatch = line.match(/^-\s+(.*)/);
    if (!bulletMatch) continue;

    const body = bulletMatch[1].trim();

    if (body.includes("summary:") || body.includes("category:")) {
      const parsed = parseChangesetBody(body);
      if (parsed) entries.push(parsed);
    } else {
      entries.push({
        summary: body.split("\n")[0].trim(),
        category: "internal",
        legacy: true,
      });
    }
  }

  return entries;
}

const entries = extractVersionEntries(version);

if (entries.length === 0) {
  console.log(`[ci-distill] No structured entries found for v${version}; skipping.`);
  process.exit(0);
}

/*
 * FNXC:Changelog 2026-07-13-15:45:
 * Prefer Claude CLI distillation (`claude -p --model sonnet`) when available
 * in the environment; otherwise soft-fallback deterministic. Never blocks.
 */
const { notes: distilledNotes, source } = await distillReleaseNotes(entries, version);
const changelogContent = readFileSync(CHANGELOG_PATH, "utf8");
const updated = replaceVersionSection(changelogContent, version, distilledNotes);

if (updated !== changelogContent) {
  writeFileSync(CHANGELOG_PATH, updated);
  console.log(`[ci-distill] Root CHANGELOG.md updated with distilled notes (source: ${source}).`);
} else {
  console.log(`[ci-distill] Version section not found in CHANGELOG.md; skipping.`);
}
