import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const APP_DIR = resolve(__dirname, "..");
const COMPONENTS_DIR = join(APP_DIR, "components");

let cached: string | null = null;
let stylesCached: string | null = null;
let themeDataCached: string | null = null;
let baseOnlyCached: string | null = null;

export function loadStylesCss(): string {
  if (stylesCached !== null) return stylesCached;
  stylesCached = readFileSync(join(APP_DIR, "styles.css"), "utf-8");
  return stylesCached;
}

export function loadThemeDataCss(): string {
  if (themeDataCached !== null) return themeDataCached;
  themeDataCached = readFileSync(join(APP_DIR, "public", "theme-data.css"), "utf-8");
  return themeDataCached;
}

export function loadAllAppCss(): string {
  if (cached !== null) return cached;
  // styles.css first (preserves all section-marker positions for legacy slice
  // tests), then component CSS files in alphabetical order. This keeps both
  // styles.css's intra-file order intact AND lets co-located component base
  // rules be matched before any cross-file @media override referencing them.
  // NOTE: public/theme-data.css is intentionally excluded here; tests that
  // validate per-color-theme contracts should load it explicitly.
  const parts: string[] = [loadStylesCss()];
  const entries = readdirSync(COMPONENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".css"))
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    parts.push(readFileSync(join(COMPONENTS_DIR, name), "utf-8"));
  }
  cached = parts.join("\n");
  return cached;
}

/**
 * Returns the combined CSS with all @media (and other at-rule) blocks
 * stripped out. Useful for tests that need to match a selector's BASE rule
 * (top-level, not inside a media query) and want to avoid false matches
 * against @media overrides that happen to come earlier in the source order.
 */
export function loadAllAppCssBaseOnly(): string {
  if (baseOnlyCached !== null) return baseOnlyCached;
  const src = loadAllAppCss();
  // Walk and excise any top-level @<rule> { ... } block (e.g. @media, @supports)
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "@") {
      const open = src.indexOf("{", i);
      if (open === -1) { out += src.slice(i); break; }
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      i = j;
      continue;
    }
    out += src[i++];
  }
  baseOnlyCached = out;
  return baseOnlyCached;
}
