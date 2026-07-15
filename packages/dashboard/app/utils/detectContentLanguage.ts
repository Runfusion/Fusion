/*
FNXC:GitHubImportTranslate 2026-07-14-12:00:
The GitHub (and GitLab) import preview must offer translation only when selected issue/PR content is in a different language than the active dashboard locale.
Client-side detection is heuristic (Unicode script counts + Latin stopword scoring) so the banner can appear without an AI round-trip; uncertain or same-family content stays silent rather than spamming a false-positive translate CTA.
*/

import type { Locale } from "@fusion/core";
import { SUPPORTED_LOCALES } from "@fusion/core";

/** Minimum alphabetic characters before we attempt language detection. */
export const MIN_DETECTABLE_CHARS = 24;

/**
 * Script/language families used for mismatch decisions.
 * zh-CN and zh-TW share `cjk` so Chinese content does not prompt translation when the UI is either Chinese locale.
 * Latin locales (en/fr/es) share `latin` at the script layer and are disambiguated via stopword scores.
 */
export type LanguageFamily = "latin" | "cjk" | "hangul" | "other";

export type DetectedContentLanguage = {
  /** Best-effort BCP-47-ish code among supported locales, or `unknown` when confidence is too low. */
  locale: Locale | "unknown";
  family: LanguageFamily;
  /** Relative confidence of the best guess. */
  confidence: "high" | "medium" | "low";
};

const LATIN_STOPWORDS: Record<"en" | "fr" | "es", readonly string[]> = {
  en: [
    "the", "and", "for", "that", "with", "this", "from", "have", "will", "are",
    "not", "but", "you", "all", "can", "has", "was", "were", "been", "their",
    "which", "when", "what", "into", "about", "would", "there", "should",
  ],
  fr: [
    "les", "des", "une", "est", "dans", "pour", "que", "qui", "sur", "avec",
    "pas", "plus", "par", "sont", "cette", "aussi", "comme", "mais", "nous",
    "vous", "être", "fait", "tout", "leur", "entre", "sans", "après",
  ],
  es: [
    "los", "las", "del", "una", "que", "por", "con", "para", "como", "más",
    "este", "esta", "está", "son", "pero", "sus", "sobre", "entre", "cuando",
    "también", "después", "desde", "hasta", "sin", "todos", "puede",
  ],
};

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches?.length ?? 0;
}

function familyForLocale(locale: Locale): LanguageFamily {
  if (locale === "ko") return "hangul";
  if (locale === "zh-CN" || locale === "zh-TW") return "cjk";
  return "latin";
}

function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Score Latin text against en/fr/es stopword lists.
 * Returns the best locale and a confidence derived from score separation.
 */
function scoreLatinLocale(text: string): { locale: Locale; confidence: DetectedContentLanguage["confidence"] } {
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-zàâäéèêëïîôùûüçñ]+/i)
    .filter((t) => t.length >= 2);

  if (tokens.length < 6) {
    return { locale: "en", confidence: "low" };
  }

  const scores: Record<"en" | "fr" | "es", number> = { en: 0, fr: 0, es: 0 };
  for (const token of tokens) {
    for (const locale of ["en", "fr", "es"] as const) {
      if (LATIN_STOPWORDS[locale].includes(token)) {
        scores[locale] += 1;
      }
    }
  }

  const ranked = (Object.entries(scores) as Array<["en" | "fr" | "es", number]>).sort(
    (a, b) => b[1] - a[1],
  );
  const [best, second] = ranked;
  const bestScore = best[1];
  const secondScore = second[1];

  if (bestScore === 0) {
    return { locale: "en", confidence: "low" };
  }

  const ratio = secondScore === 0 ? Infinity : bestScore / secondScore;
  const confidence: DetectedContentLanguage["confidence"] =
    bestScore >= 4 && ratio >= 1.6 ? "high" : bestScore >= 2 && ratio >= 1.25 ? "medium" : "low";

  return { locale: best[0], confidence };
}

/**
 * Detect the likely language of free-form issue/PR content for import-preview translation gating.
 * Intentionally conservative: short, code-heavy, or ambiguous samples return `unknown` / low confidence.
 */
export function detectContentLanguage(text: string): DetectedContentLanguage {
  const sample = (text ?? "").trim();
  if (!sample) {
    return { locale: "unknown", family: "other", confidence: "low" };
  }

  // Strip fenced code, URLs, and GitHub usernames so detection focuses on prose.
  const cleaned = sample
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@[\w-]+/g, " ")
    .replace(/#\d+/g, " ");

  const hangul = countMatches(cleaned, /[\uAC00-\uD7AF]/g);
  const hiraganaKatakana = countMatches(cleaned, /[\u3040-\u30FF]/g);
  const cjk = countMatches(cleaned, /[\u4E00-\u9FFF]/g);
  const latin = countMatches(cleaned, /[A-Za-zÀ-ÖØ-öø-ÿ]/g);
  const letters = hangul + hiraganaKatakana + cjk + latin;

  if (letters < MIN_DETECTABLE_CHARS) {
    return { locale: "unknown", family: "other", confidence: "low" };
  }

  const hangulShare = hangul / letters;
  const cjkShare = cjk / letters;
  const latinShare = latin / letters;

  if (hangulShare >= 0.35) {
    return {
      locale: "ko",
      family: "hangul",
      confidence: hangulShare >= 0.55 ? "high" : "medium",
    };
  }

  // Japanese (hiragana/katakana present) is not a dashboard locale — treat as non-matching CJK family.
  if (hiraganaKatakana >= 8 || (hiraganaKatakana >= 3 && cjkShare >= 0.2)) {
    return { locale: "unknown", family: "cjk", confidence: "high" };
  }

  if (cjkShare >= 0.35) {
    // Cannot reliably split zh-CN vs zh-TW without a dictionary; either Chinese UI locale
    // should suppress the translate CTA for CJK prose.
    return {
      locale: "zh-CN",
      family: "cjk",
      confidence: cjkShare >= 0.55 ? "high" : "medium",
    };
  }

  if (latinShare >= 0.55) {
    const latinGuess = scoreLatinLocale(cleaned);
    return {
      locale: latinGuess.locale,
      family: "latin",
      confidence: latinGuess.confidence,
    };
  }

  return { locale: "unknown", family: "other", confidence: "low" };
}

/**
 * Whether import-preview content should offer translation into `dashboardLocale`.
 * Requires medium+ confidence and a family/locale mismatch so we do not nag same-language content.
 */
export function contentNeedsTranslation(
  text: string,
  dashboardLocale: Locale,
): { needed: boolean; detected: DetectedContentLanguage } {
  const detected = detectContentLanguage(text);
  if (detected.confidence === "low" || detected.locale === "unknown") {
    // Still offer when family is clearly foreign (e.g. Japanese kana) even if locale is unknown.
    if (detected.confidence === "high" && detected.family !== familyForLocale(dashboardLocale) && detected.family !== "other") {
      return { needed: true, detected };
    }
    return { needed: false, detected };
  }

  if (detected.locale === dashboardLocale) {
    return { needed: false, detected };
  }

  // Chinese UI locales treat Simplified/Traditional detection as same family.
  if (
    familyForLocale(dashboardLocale) === "cjk" &&
    detected.family === "cjk" &&
    isSupportedLocale(detected.locale) &&
    familyForLocale(detected.locale) === "cjk"
  ) {
    return { needed: false, detected };
  }

  // Latin locales that share the same stopword winner as dashboard.
  if (detected.locale === dashboardLocale) {
    return { needed: false, detected };
  }

  // Require medium+ confidence for same-script (latin) mismatches to limit false positives.
  if (detected.family === familyForLocale(dashboardLocale) && detected.confidence !== "high") {
    return { needed: false, detected };
  }

  return { needed: true, detected };
}

/** Human-readable endonym for a detected/source locale chip in the translate banner. */
export function localeDisplayName(locale: Locale | "unknown"): string {
  switch (locale) {
    case "en":
      return "English";
    case "zh-CN":
      return "简体中文";
    case "zh-TW":
      return "繁體中文";
    case "fr":
      return "Français";
    case "es":
      return "Español";
    case "ko":
      return "한국어";
    default:
      return locale;
  }
}
