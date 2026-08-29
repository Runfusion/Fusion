#!/usr/bin/env tsx
/* global console, process */
/*
 * FNXC:i18n-ParityGate 2026-06-20-00:00:
 * `pnpm i18n:status` is a read-only key-structure gate, not a translation-completeness gate.
 * Secondary locales intentionally keep untranslated entries as empty strings for fallback-to-`en`, so this script fails only for missing catalog keys or stale orphan keys.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findParityViolations } from "../src/parity.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");
const localesRoot = join(packageRoot, "locales");
const primaryLocale = "en";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listSupportedLocales() {
  const configText = readFileSync(join(repoRoot, "i18next.config.ts"), "utf8");
  const localesMatch = configText.match(/locales:\s*\[([^\]]+)\]/m);
  if (!localesMatch) {
    throw new Error("Unable to read locales from i18next.config.ts");
  }
  return [...localesMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function listPrimaryNamespaces() {
  const primaryDir = join(localesRoot, primaryLocale);
  return readdirSync(primaryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => basename(entry.name, ".json"))
    .sort();
}

function loadCatalogs(locale, namespaces) {
  const catalogs = {};
  for (const namespace of namespaces) {
    const catalogPath = join(localesRoot, locale, `${namespace}.json`);
    if (existsSync(catalogPath)) {
      catalogs[namespace] = readJson(catalogPath);
    }
  }
  return catalogs;
}

function groupViolations(violations) {
  const grouped = new Map();
  for (const violation of violations) {
    const localeGroup = grouped.get(violation.locale) ?? new Map();
    const namespaceGroup = localeGroup.get(violation.namespace) ?? { absent: [], orphan: [] };
    namespaceGroup[violation.kind].push(violation.key);
    localeGroup.set(violation.namespace, namespaceGroup);
    grouped.set(violation.locale, localeGroup);
  }
  return grouped;
}

function formatKeyList(keys) {
  return keys.sort().map((key) => `    - ${key}`).join("\n");
}

export function run() {
  const namespaces = listPrimaryNamespaces();
  const sourceCatalogs = loadCatalogs(primaryLocale, namespaces);
  const secondaryLocales = listSupportedLocales().filter((locale) => locale !== primaryLocale);
  const violations = [];

  for (const locale of secondaryLocales) {
    const localeCatalogs = loadCatalogs(locale, namespaces);
    violations.push(...findParityViolations(sourceCatalogs, localeCatalogs, { locale }));
  }

  if (violations.length === 0) {
    console.log(
      `✔ i18n key parity intact across ${secondaryLocales.length} secondary locale(s) / ${namespaces.length} namespace(s).`,
    );
    return 0;
  }

  console.error("✖ i18n key parity violations detected.");
  console.error("\nSecondary locale catalogs must match the authored en catalog key structure.");

  for (const [locale, namespacesByLocale] of groupViolations(violations)) {
    console.error(`\n${locale}:`);
    for (const [namespace, byKind] of namespacesByLocale) {
      if (byKind.absent.length > 0) {
        console.error(`  [${namespace}] ${byKind.absent.length} absent key(s):`);
        console.error(formatKeyList(byKind.absent));
      }
      if (byKind.orphan.length > 0) {
        console.error(`  [${namespace}] ${byKind.orphan.length} orphan key(s):`);
        console.error(formatKeyList(byKind.orphan));
      }
    }
  }

  console.error("\nRemediation:");
  console.error("  - Run `pnpm i18n:sync` and commit generated secondary-locale keys for absent-key violations.");
  console.error("  - Remove or reconcile stale secondary-locale keys for orphan-key violations.");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = run();
}
