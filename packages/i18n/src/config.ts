import { DEFAULT_LOCALE, isLocale, type Locale, SUPPORTED_LOCALES } from "@fusion/core";
import type { FallbackLngObjList, InitOptions } from "i18next";
import namespaces from "../namespaces.json";

/**
 * Shared, framework-agnostic i18next configuration for both Fusion UI surfaces.
 *
 * The dashboard (browser) and the terminal UI (Node) each build their own
 * i18next instance, but they share the locale list, namespace split, fallback
 * chain, and base options defined here so the two surfaces stay consistent.
 */

/** All translation namespaces. Split so each surface loads only what it needs.
 *  Sourced from namespaces.json so the build scripts and this config can never
 *  drift (the scripts read the same JSON). */
export type Namespace = "common" | "app" | "errors" | "cli";
export const NAMESPACES = namespaces.all as readonly Namespace[];

/** Default namespace keys resolve against when none is specified. */
export const DEFAULT_NAMESPACE: Namespace = "common";

/** Namespaces the browser dashboard loads (skips the terminal-only `cli`). */
export const DASHBOARD_NAMESPACES = namespaces.dashboard as readonly Namespace[];

/** Namespaces the terminal UI loads (skips the dashboard-only `app`). */
export const CLI_NAMESPACES = namespaces.cli as readonly Namespace[];

/**
 * Script-aware fallback chain. A generic `zh` resolves to Simplified, the
 * Han-script tags resolve to their region catalog, and everything else falls
 * back to the source language. Combined with `load: "currentOnly"` this keeps
 * `zh-CN` and `zh-TW` from ever collapsing into a single generic `zh`.
 */
export const FALLBACK_LNG: FallbackLngObjList = {
  "zh-Hans": ["zh-CN"],
  "zh-Hant": ["zh-TW"],
  zh: ["zh-CN"],
  default: [DEFAULT_LOCALE],
};

/**
 * Base init options shared by every surface. Each surface spreads these and
 * adds its own resource-loading strategy (lazy backend for the dashboard,
 * static `resources` for the CLI) plus framework plugins.
 */
/**
 * Normalize a BCP-47-ish or POSIX-ish language tag to a supported {@link Locale},
 * or undefined when nothing matches. Shared by the dashboard (navigator
 * detection) and the CLI (env detection) so Chinese script/region resolution is
 * identical on both surfaces — Traditional tags (zh-Hant, zh-TW, zh-HK, zh-MO)
 * resolve to zh-TW, everything else Chinese to zh-CN, and region subtags on
 * other languages strip to the base.
 */
export function normalizeToSupportedLocale(tag: string): Locale | undefined {
  if (!tag) return undefined;
  const norm = tag.replaceAll("_", "-");
  if (isLocale(norm)) return norm;

  const lower = norm.toLowerCase();
  if (lower.startsWith("zh")) {
    // An explicit Simplified script subtag wins over region: zh-Hans-HK /
    // zh-Hans-MO are valid BCP-47 for Simplified Chinese used in HK/Macau.
    if (lower.includes("hans")) return "zh-CN";
    if (
      lower.includes("hant") ||
      lower.includes("-tw") ||
      lower.includes("-hk") ||
      lower.includes("-mo")
    ) {
      return "zh-TW";
    }
    return "zh-CN";
  }

  const base = lower.split("-")[0];
  return isLocale(base) ? base : undefined;
}

export function baseInitOptions(): InitOptions {
  return {
    supportedLngs: [...SUPPORTED_LOCALES],
    fallbackLng: FALLBACK_LNG,
    // Never collapse zh-CN/zh-TW into a generic `zh`.
    load: "currentOnly",
    nonExplicitSupportedLngs: false,
    // React (and Ink) escape on render; double-escaping mangles output.
    interpolation: { escapeValue: false },
    returnNull: false,
    // Untranslated keys are backfilled with "" placeholders across the non-en
    // catalogs (hundreds of them). With i18next's default returnEmptyString:true
    // those render blank — even when a component passes an inline English default
    // to t() — because an empty string is still a "found" value. Setting this
    // false makes empty values fall through the fallback chain to en, which is
    // the intended behavior for the placeholder convention.
    returnEmptyString: false,
  };
}
