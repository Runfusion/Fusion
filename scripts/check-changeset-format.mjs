#!/usr/bin/env node
/*
 * FNXC:Changelog 2026-06-24-15:00:
 * Changeset format linter. Validates that all .changeset/*.md files follow
 * the structured schema (summary, category, dev labeled fields). During the
 * transition period, legacy freeform changesets produce warnings (exit 0).
 * Structurally invalid changesets (partial fields, bad category, over-length
 * summary) always produce errors (exit 1). Use --strict to fail on legacy
 * changesets.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseChangesetFile, validateChangeset, CATEGORIES } from "./lib/changeset-schema.mjs";

const STRICT = process.argv.includes("--strict");
const CHANGESET_DIR = ".changeset";

/**
 * Scan all .changeset/*.md files (excluding README.md) and return findings.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function scanChangesets(dir = CHANGESET_DIR) {
  const errors = [];
  const warnings = [];

  if (!existsSync(dir)) {
    return { errors, warnings };
  }

  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );

  for (const file of files) {
    const filePath = join(dir, file);
    const raw = readFileSync(filePath, "utf8");
    const { parsed } = parseChangesetFile(raw);

    if (!parsed) {
      errors.push(`${file}: empty or unparseable body`);
      continue;
    }

    if (parsed.legacy && !STRICT) {
      warnings.push(
        `${file}: legacy freeform format (no labeled fields). Expected: summary, category, dev.`,
      );
      continue;
    }

    if (parsed.legacy && STRICT) {
      errors.push(
        `${file}: legacy freeform format not allowed in --strict mode. Migrate to labeled fields (summary, category, dev).`,
      );
      continue;
    }

    const validation = validateChangeset(parsed);
    if (!validation.valid) {
      for (const err of validation.errors) {
        errors.push(`${file}: ${err}`);
      }
    }
  }

  return { errors, warnings };
}

export function main() {
  const { errors, warnings } = scanChangesets();

  for (const w of warnings) {
    console.warn(`  WARN  ${w}`);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`  FAIL  ${e}`);
    }
    console.error(
      `\nChangeset format check failed. Valid categories: ${CATEGORIES.join(", ")}.`,
    );
    console.error(
      "Expected body format:\n  summary: One-line user-facing description.\n  category: <one of: " +
        CATEGORIES.join(", ") + ">\n  dev: Optional developer detail.",
    );
    return 1;
  }

  if (warnings.length > 0) {
    console.warn(
      `\nChangeset format check passed with ${warnings.length} legacy warning(s).`,
    );
  }

  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
