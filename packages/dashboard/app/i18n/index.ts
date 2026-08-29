import {
  baseInitOptions,
  DASHBOARD_NAMESPACES,
  DEFAULT_NAMESPACE,
  normalizeToSupportedLocale,
} from "@fusion/i18n/config";
import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";

/**
 * Browser i18next instance for the dashboard.
 *
 * Catalogs are loaded lazily per locale: only the active locale's namespaces
 * are fetched on first paint; switching language fetches the new locale's
 * chunk on demand. The dynamic import is **app-relative** over the generated
 * `app/locales/` tree (synced from @fusion/i18n by scripts/sync-locales.mjs)
 * so Vite statically analyses it and emits one chunk per locale/namespace.
 */

/** localStorage key for the persisted language. Uses the neighbor-consistent
 *  `kb-dashboard-*` prefix (see useTheme.ts) — not changed to `fn-` here; that
 *  belongs to the brand-rename track. */
export const LANGUAGE_STORAGE_KEY = "kb-dashboard-language";

i18next
  .use(LanguageDetector)
  .use(
    resourcesToBackend(
      (language: string, namespace: string) =>
        import(`../locales/${language}/${namespace}.json`),
    ),
  )
  .use(initReactI18next);

export const i18nReady = i18next.init({
  ...baseInitOptions(),
  ns: [...DASHBOARD_NAMESPACES],
  defaultNS: DEFAULT_NAMESPACE,
  detection: {
    order: ["localStorage", "navigator", "htmlTag"],
    lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    // Don't auto-persist the *detected* locale: the detector would write the
    // storage key during init, and useLanguage distinguishes a real user choice
    // from mere detection by this key's presence (its server-settings hydration
    // tier only fires when no local choice exists). setLanguage() writes the
    // key explicitly on actual user choices.
    caches: [],
    // Normalize multi-subtag detections (e.g. navigator "zh-Hans-CN" /
    // "zh-Hant-TW") to a supported locale before fallback, matching the CLI's
    // env detection.
    convertDetectedLanguage: (lng: string) => normalizeToSupportedLocale(lng) ?? lng,
  },
  react: {
    // First paint is gated on `i18nReady` in main.tsx, so Suspense is not
    // needed to avoid raw-key flashes and would otherwise require a boundary
    // around every translated subtree.
    useSuspense: false,
  },
});

i18next.on("languageChanged", (language) => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
});

export default i18next;
