/* global console, process */
// KTD3a regression guard: after a client build, assert that each locale's
// catalogs are emitted as their own async chunks and are NOT folded into the
// main entry chunk. If the app-relative dynamic import ever stops being
// statically analysable, Vite silently inlines every catalog into the main
// bundle with only a build warning — this check turns that into a hard failure.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "..", "dist", "client", "assets");
const i18nRoot = join(here, "..", "..", "i18n");
// Single source of truth shared with @fusion/i18n config.ts.
const namespaces = JSON.parse(readFileSync(join(i18nRoot, "namespaces.json"), "utf8")).dashboard;

// Derive the expected per-namespace chunk floor from the authored locale set
// rather than hardcoding a count, so adding a locale needs no edit here. Only
// directories that actually contain the default-namespace catalog count as
// locales, so a stray dir (editor artifact, partial sync) can't inflate the
// floor and produce a spurious failure.
const localesDir = join(i18nRoot, "locales");
const expectedLocaleCount = readdirSync(localesDir, { withFileTypes: true }).filter(
  (d) => d.isDirectory() && existsSync(join(localesDir, d.name, "common.json")),
).length;

if (!existsSync(assetsDir)) {
  console.error(`assert-locale-chunks: ${assetsDir} not found — run the client build first.`);
  process.exit(1);
}

const files = readdirSync(assetsDir);
const errors = [];

// One chunk per dashboard namespace per locale (5 locales) → at least 5 each.
for (const ns of namespaces) {
  const matches = files.filter((f) => new RegExp(`^${ns}-[^/]+\\.js$`).test(f));
  if (matches.length < expectedLocaleCount) {
    errors.push(
      `expected >=${expectedLocaleCount} split chunks for namespace "${ns}" (one per locale), found ${matches.length}`,
    );
  }
}

// The main entry chunk must not carry catalog payloads — a translated marker
// string from a non-en catalog appearing in index-*.js means splitting broke.
const indexFile = files.find((f) => /^index-[^/]+\.js$/.test(f));
if (indexFile) {
  const body = readFileSync(join(assetsDir, indexFile), "utf8");
  // i18next-resources-to-backend chunks are referenced by dynamic import, not
  // inlined; a literal catalog object in index would show the column labels.
  if (/"in-review":"In Review"/.test(body) && /"archived":"Archived"/.test(body)) {
    errors.push(`catalog content found inlined in ${indexFile} — locale chunks were not split`);
  }
}

if (errors.length) {
  console.error("assert-locale-chunks FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("assert-locale-chunks: per-locale catalog chunks emitted correctly.");
