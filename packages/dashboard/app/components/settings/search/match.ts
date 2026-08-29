/**
 * Settings search matching and ranking.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * Every setting's label AND help text are indexed, which is the whole point of the rewrite: the previous index was a hand-written `searchableText` keyword array per nav entry, and it rotted exactly as you would expect. Project Models accumulated twenty keywords across two separate fixes (FN-7907, then title-summarization on 2026-07-14) because operators searched "summarize" and the section did not surface. Indexing the copy operators actually read removes that maintenance surface.
 * Matching is substring, not fuzzy: settings vocabulary is short and domain-specific, and fuzzy matching on a 900-entry index surfaces confusing near-misses ("merge" matching "memory") that make the results feel broken. Substring over label+help+keywords covers the real miss cases.
 * Ranking exists because a query like "model" legitimately hits dozens of settings; label matches must outrank help-text matches, or the result list leads with settings that merely mention the word in passing.
 */
import type { SettingsSearchEntry, SettingsSearchResult } from "./types";

/**
 * Case/whitespace-normalizes a query or candidate for comparison. Uses
 * locale-aware lowercasing to match the existing settings-search behavior.
 */
export function normalizeSettingsSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Score tiers. Lower is better. A label hit always outranks a help hit, and an
 * exact/prefix label hit outranks a mid-word one, so searching "merge" leads
 * with the Merge settings rather than with an unrelated control whose help text
 * happens to mention merging.
 */
const SCORE_LABEL_EXACT = 0;
const SCORE_LABEL_PREFIX = 1;
const SCORE_LABEL_SUBSTRING = 2;
const SCORE_KEYWORD = 3;
const SCORE_KEY = 4;
const SCORE_HELP = 5;

/**
 * Scores one entry against an already-normalized query, or returns null when it
 * does not match. `label`/`help` arrive pre-resolved in the active locale.
 */
export function scoreSettingsSearchEntry(
  entry: SettingsSearchEntry,
  query: string,
  label: string,
  help: string | undefined,
): number | null {
  const normalizedLabel = normalizeSettingsSearchText(label);
  if (normalizedLabel === query) return SCORE_LABEL_EXACT;
  if (normalizedLabel.startsWith(query)) return SCORE_LABEL_PREFIX;
  if (normalizedLabel.includes(query)) return SCORE_LABEL_SUBSTRING;

  if (entry.keywords?.some((k) => normalizeSettingsSearchText(k).includes(query))) {
    return SCORE_KEYWORD;
  }

  /*
  FNXC:SettingsSearch 2026-07-15-17:35:
  The field name is searchable so an operator who knows a setting from its config file, an export, or a support thread can paste `autoSummarizeTitles` and land on the control. It ranks below prose because it is the developer-facing name, not what the UI calls the setting.
  */
  if (normalizeSettingsSearchText(entry.key).includes(query)) return SCORE_KEY;

  if (help && normalizeSettingsSearchText(help).includes(query)) return SCORE_HELP;

  return null;
}

/**
 * Filters and ranks the index for a query.
 *
 * `resolve` maps an i18n key + English fallback to the active locale's string;
 * callers pass i18next's `t`. Resolution happens here rather than in the index
 * so results follow a language switch without rebuilding it.
 */
export function rankSettingsSearchResults(
  entries: readonly SettingsSearchEntry[],
  rawQuery: string,
  resolve: (key: string, fallback: string) => string,
): SettingsSearchResult[] {
  const query = normalizeSettingsSearchText(rawQuery);
  if (!query) return [];

  const results: SettingsSearchResult[] = [];
  for (const entry of entries) {
    const label = resolve(entry.labelKey, entry.labelFallback);
    const help = entry.helpKey && entry.helpFallback
      ? resolve(entry.helpKey, entry.helpFallback)
      : undefined;
    const score = scoreSettingsSearchEntry(entry, query, label, help);
    if (score === null) continue;
    results.push({ ...entry, label, help, score });
  }

  /*
  FNXC:SettingsSearch 2026-07-15-17:35:
  Ties break on label so results hold a stable, alphabetical order across keystrokes. Without it the list is in index-declaration order, which reshuffles as entries are added and makes the list appear to jump while the operator is still typing.
  */
  return results.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}

/** Section ids owning at least one matching setting, for filtering the nav. */
export function matchedSectionIds(results: readonly SettingsSearchResult[]): Set<string> {
  return new Set(results.map((r) => r.sectionId));
}
