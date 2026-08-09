import "./LanguageSelector.css";
import type { Locale } from "@fusion/core";
import { useTranslation } from "react-i18next";
import { useLanguage } from "../hooks/useLanguage";

/** Each language names itself (endonyms), intentionally untranslated. */
const ENDONYMS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  fr: "Français",
  es: "Español",
  ko: "한국어",
  "pt-BR": "Português (Brasil)",
};

/** Settings control for choosing the UI language. Applies in place (no reload). */
export function LanguageSelector() {
  const { t } = useTranslation("app");
  const { language, supportedLocales, setLanguage, clearLanguage, hasExplicitChoice } =
    useLanguage();
  const label = t("settings.appearance.language", "Language");

  return (
    <div className="language-selector">
      <div className="language-selector-title">{label}</div>
      {/* role="group" + aria-pressed: toggle-button semantics (radiogroup would
          conflict with aria-pressed and confuse screen readers). */}
      <div className="language-options" role="group" aria-label={label}>
        <button
          type="button"
          className={`language-option${hasExplicitChoice ? "" : " active"}`}
          onClick={clearLanguage}
          aria-pressed={!hasExplicitChoice}
          title={t("settings.appearance.languageAutoHint", "Follow the browser language")}
        >
          {t("settings.appearance.languageAuto", "Auto")}
        </button>
        {supportedLocales.map((locale) => (
          <button
            key={locale}
            type="button"
            className={`language-option${hasExplicitChoice && language === locale ? " active" : ""}`}
            onClick={() => setLanguage(locale)}
            aria-pressed={hasExplicitChoice && language === locale}
            lang={locale}
          >
            {ENDONYMS[locale]}
          </button>
        ))}
      </div>
    </div>
  );
}
