import { DEFAULT_LOCALE, isLocale, type Locale, SUPPORTED_LOCALES } from "@fusion/core";
import { normalizeToSupportedLocale } from "@fusion/i18n/config";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";
import { LANGUAGE_STORAGE_KEY } from "../i18n";

const isBrowser = typeof window !== "undefined";

function readCachedLanguage(): Locale | undefined {
  if (!isBrowser) return undefined;
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLocale(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** Re-run browser language detection, mirroring the i18next detector's
 *  navigator step (used when the user clears their explicit choice). */
function detectBrowserLocale(): Locale {
  if (!isBrowser) return DEFAULT_LOCALE;
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const match = normalizeToSupportedLocale(candidate);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export interface UseLanguageReturn {
  language: Locale;
  supportedLocales: readonly Locale[];
  setLanguage: (locale: Locale) => void;
  /** Drop the explicit choice everywhere (localStorage + server) and revert
   *  to runtime auto-detection. */
  clearLanguage: () => void;
  /** True when the user has explicitly chosen a language (vs auto-detect). */
  hasExplicitChoice: boolean;
}

/**
 * Language preference hook. Mirrors useTheme's three-tier persistence:
 * - the i18next browser detector seeds the active locale from localStorage,
 * - the user's choice writes through to localStorage and server GlobalSettings,
 * - server settings hydrate the locale on mount when no local choice exists.
 *
 * Switching applies in place via `i18n.changeLanguage` — no full-page reload,
 * so unsaved state and in-flight agent views survive a language change.
 */
export function useLanguage(): UseLanguageReturn {
  const { i18n } = useTranslation();
  const resolved = i18n.resolvedLanguage ?? i18n.language;
  const initial: Locale = isLocale(resolved) ? resolved : DEFAULT_LOCALE;
  const [language, setLanguageState] = useState<Locale>(initial);
  const [hasExplicitChoice, setHasExplicitChoice] = useState<boolean>(
    () => readCachedLanguage() !== undefined,
  );
  const userSetRef = useRef(false);

  // Reflect any i18next language change (including programmatic ones) into state.
  useEffect(() => {
    const handler = (lng: string) => {
      if (isLocale(lng)) setLanguageState(lng);
    };
    i18n.on("languageChanged", handler);
    return () => {
      i18n.off("languageChanged", handler);
    };
  }, [i18n]);

  // Keep tabs in sync: when another tab changes the persisted language, adopt it
  // here too (the storage event only fires in *other* tabs, so this never loops).
  useEffect(() => {
    if (!isBrowser) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_STORAGE_KEY) return;
      if (isLocale(event.newValue)) {
        setHasExplicitChoice(true);
        if (event.newValue !== i18n.resolvedLanguage) {
          void i18n.changeLanguage(event.newValue);
        }
      } else if (event.newValue === null) {
        // Another tab cleared the choice — revert to auto-detect here too.
        setHasExplicitChoice(false);
        const detected = detectBrowserLocale();
        if (detected !== i18n.resolvedLanguage) {
          void i18n.changeLanguage(detected);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [i18n]);

  // Hydrate from server settings, but never override a local/user choice.
  useEffect(() => {
    if (!isBrowser) return;
    let cancelled = false;

    void fetchGlobalSettings()
      .then((settings) => {
        if (cancelled || userSetRef.current) return;
        const serverLocale = isLocale(settings.language) ? settings.language : undefined;
        if (serverLocale && !readCachedLanguage() && serverLocale !== i18n.resolvedLanguage) {
          void i18n.changeLanguage(serverLocale);
        }
      })
      .catch((error) => {
        console.warn("[useLanguage] Failed to hydrate language from global settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [i18n]);

  const setLanguage = useCallback(
    (locale: Locale) => {
      userSetRef.current = true;
      setLanguageState(locale);
      setHasExplicitChoice(true);
      // changeLanguage re-renders the tree in place; the storage key is the
      // marker for "explicit user choice", written only here.
      void i18n.changeLanguage(locale);
      try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
      } catch {
        // localStorage unavailable — server write-through below still runs.
      }
      void updateGlobalSettings({ language: locale }).catch((error) => {
        console.warn("[useLanguage] Failed to persist language to global settings", error);
      });
    },
    [i18n],
  );

  const clearLanguage = useCallback(() => {
    userSetRef.current = true;
    setHasExplicitChoice(false);
    try {
      localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    } catch {
      // localStorage unavailable — server clear below still runs.
    }
    // `language: null` is null-as-delete at the store boundary: the persisted
    // key is removed and every surface reverts to runtime auto-detection.
    void updateGlobalSettings({ language: null } as unknown as Parameters<
      typeof updateGlobalSettings
    >[0]).catch((error) => {
      console.warn("[useLanguage] Failed to clear language in global settings", error);
    });
    void i18n.changeLanguage(detectBrowserLocale());
  }, [i18n]);

  return { language, supportedLocales: SUPPORTED_LOCALES, setLanguage, clearLanguage, hasExplicitChoice };
}
