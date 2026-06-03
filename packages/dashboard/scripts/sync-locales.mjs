/* global console */
// Copies the authored @fusion/i18n catalogs into the dashboard tree so Vite can
// code-split them per locale via a plainly app-relative dynamic import. The
// generated app/locales/ dir is gitignored — @fusion/i18n/locales is the
// source-of-truth. Only the dashboard namespaces are copied (the terminal-only
// `cli` namespace is skipped). Runs as a predev/prebuild step.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(here, "..");
const srcLocales = join(dashboardRoot, "..", "i18n", "locales");
const destLocales = join(dashboardRoot, "app", "locales");

// Keep in sync with DASHBOARD_NAMESPACES in @fusion/i18n config.ts.
const DASHBOARD_NAMESPACES = ["common", "app", "errors"];

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
