import { DEFAULT_LOCALE, isLocale, type Locale } from "@fusion/core";
import {
  baseInitOptions,
  CLI_NAMESPACES,
  cliResources,
  DEFAULT_NAMESPACE,
  normalizeToSupportedLocale,
} from "@fusion/i18n";
import i18next, { type i18n as I18nInstance, type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Terminal-UI i18next instance.
 *
 * Unlike the dashboard, the CLI bundles all catalogs statically (via the
 * generated @fusion/i18n cli map) and initializes synchronously (inline
 * resources, no async backend) so the very first rendered Ink frame is
 * already localized — no flash of untranslated keys.
 */

/**
 * Parse a POSIX locale environment value (e.g. `fr_FR.UTF-8`, `zh_CN`,
 * `zh-Hant`) into a supported {@link Locale}, or undefined when none matches.
 */
export function detectEnvLocale(env: NodeJS.ProcessEnv = process.env): Locale | undefined {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE;
  if (!raw) return undefined;
  // Strip encoding/modifier (`.UTF-8`, `@euro`), then normalize via the shared
  // helper so env detection matches the dashboard's navigator detection
  // (incl. Traditional-script Chinese → zh-TW).
  return normalizeToSupportedLocale(raw.split(/[.:@\s]/)[0]);
}

/**
 * Resolve the active CLI locale with precedence:
 * `--lang flag → persisted GlobalSettings.language → environment → en`.
 */
export function resolveCliLocale(opts: {
  flag?: string | undefined;
  setting?: string | undefined;
  env?: NodeJS.ProcessEnv;
} = {}): Locale {
  const { flag, setting, env = process.env } = opts;
  if (isLocale(flag)) return flag;
  if (isLocale(setting)) return setting;
  return detectEnvLocale(env) ?? DEFAULT_LOCALE;
}

let initialized = false;

/** Initialize (synchronously) or switch the CLI i18next instance to `locale`. */
export function initCliI18n(locale: Locale): I18nInstance {
  if (!initialized) {
    void i18next.use(initReactI18next).init({
      ...baseInitOptions(),
      lng: locale,
      ns: [...CLI_NAMESPACES],
      defaultNS: DEFAULT_NAMESPACE,
      // Inline resources + no async backend => init completes synchronously,
      // so the first rendered Ink frame is already localized (i18next v26
      // dropped the old `initImmediate` flag; this is now the default for
      // backend-less, resource-inlined init).
      resources: cliResources as unknown as Resource,
      react: { useSuspense: false },
    });
    initialized = true;
  } else if (i18next.language !== locale) {
    // changeLanguage is async; the instance carries the previous locale until
    // the microtask queue drains. Benign in production (called once per
    // process) — callers that need the settled locale before rendering should
    // await i18next.changeLanguage(locale) directly.
    void i18next.changeLanguage(locale);
  }
  return i18next;
}

export { i18next as cliI18n };
