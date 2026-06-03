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
const namespaces = ["common", "app", "errors"];

if (!existsSync(assetsDir)) {
  console.error(`assert-locale-chunks: ${assetsDir} not found — run the client build first.`);
  process.exit(1);
}

const files = readdirSync(assetsDir);
const errors = [];

// One chunk per dashboard namespace per locale (5 locales) → at least 5 each.
for (const ns of namespaces) {
  const matches = files.filter((f) => new RegExp(`^${ns}-[^/]+\\.js$`).test(f));
  if (matches.length < 5) {
    errors.push(
      `expected >=5 split chunks for namespace "${ns}" (one per locale), found ${matches.length}`,
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
