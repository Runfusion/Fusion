/* global console */
// Copies the authored @fusion/i18n catalogs into the dashboard tree so Vite can
// code-split them per locale via a plainly app-relative dynamic import. The
// generated app/locales/ dir is gitignored — @fusion/i18n/locales is the
// source-of-truth. Only the dashboard namespaces are copied (the terminal-only
// `cli` namespace is skipped). Runs as a predev/prebuild step.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(here, "..");
const i18nRoot = join(dashboardRoot, "..", "i18n");
const srcLocales = join(i18nRoot, "locales");
const destLocales = join(dashboardRoot, "app", "locales");

// Single source of truth shared with @fusion/i18n config.ts.
const DASHBOARD_NAMESPACES = JSON.parse(
  readFileSync(join(i18nRoot, "namespaces.json"), "utf8"),
).dashboard;

const locales = readdirSync(srcLocales, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

rmSync(destLocales, { recursive: true, force: true });
for (const lng of locales) {
  mkdirSync(join(destLocales, lng), { recursive: true });
  for (const ns of DASHBOARD_NAMESPACES) {
    cpSync(join(srcLocales, lng, `${ns}.json`), join(destLocales, lng, `${ns}.json`));
  }
}

console.log(`Synced ${locales.length} locale(s) into app/locales: ${locales.join(", ")}`);
