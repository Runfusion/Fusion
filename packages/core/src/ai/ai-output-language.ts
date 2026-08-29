/*
FNXC:TaskOutputLanguage 2026-08-19-14:56:
Task-facing AI prose has one project-scoped language contract. The resolver is pure so a caller can
snapshot its result at generation start; later settings writes must not retarget an active session.
*/
import { DEFAULT_LOCALE, isLocale, type Locale, type Settings } from "../types.js";
import { detectContentLanguage, localeDisplayName } from "../i18n/detect-content-language.js";

export type TaskOutputLanguage = "english" | "input" | "interface";

export interface ResolvedTaskOutputLanguage {
  mode: TaskOutputLanguage;
  locale: Locale | undefined;
  /** A reusable instruction limited to human-authored task-facing prose. */
  instruction: string;
}

export function isTaskOutputLanguage(value: unknown): value is TaskOutputLanguage {
  return value === "english" || value === "input" || value === "interface";
}

/** Resolve a stable AI-output target from a merged settings snapshot and original user text. */
export function resolveTaskOutputLanguage(settings: Partial<Settings> | undefined, input: string): ResolvedTaskOutputLanguage {
  const explicit = settings?.taskOutputLanguage;
  const mode: TaskOutputLanguage = isTaskOutputLanguage(explicit)
    ? explicit
    : settings?.taskDefinitionInInputLanguage === true ? "input" : "english";
  const detected = detectContentLanguage(input);
  const detectedLocale = detected.locale !== "unknown" && (detected.confidence === "medium" || detected.confidence === "high")
    ? detected.locale
    : undefined;

  if (mode === "english") {
    return { mode, locale: "en", instruction: "Write all human-readable AI-authored task-facing prose in English. Keep machine-readable syntax, identifiers, headings, code, paths, and tool names canonical and verbatim." };
  }
  if (mode === "interface") {
    const locale = isLocale(settings?.language) ? settings.language : DEFAULT_LOCALE;
    return { mode, locale, instruction: `Write all human-readable AI-authored task-facing prose in the Fusion interface language: ${localeDisplayName(locale)} (${locale}). Keep machine-readable syntax, identifiers, headings, code, paths, and tool names canonical and verbatim.` };
  }
  const hint = detectedLocale ? ` The detected input-language hint is ${localeDisplayName(detectedLocale)} (${detectedLocale}).` : "";
  return { mode, locale: detectedLocale, instruction: `Write all human-readable AI-authored task-facing prose in the same language as the original user input.${hint} Keep machine-readable syntax, identifiers, headings, code, paths, and tool names canonical and verbatim.` };
}
