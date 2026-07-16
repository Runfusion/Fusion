/**
 * Settings search index types.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * Search resolves to individual settings, not just sections, so the index is a flat list of every setting the modal can render. One entry = one control the operator can land on.
 * `key` is load-bearing twice over: it is the settings field name the section's descriptor declares, AND the `data-settings-key` anchor its rendered row carries. That identity is what lets a search result scroll to the exact control, and it is why entries are keyed by field name rather than by i18n key (several settings share help copy, and i18n keys are not unique per control).
 * Label and help are stored as i18n key + English fallback rather than resolved strings: the index is a module-scope constant evaluated before i18next initializes, and search must match against the operator's active locale, so resolution is deferred to query time.
 */

/** One searchable setting, addressable by `key` within `sectionId`. */
export interface SettingsSearchEntry {
  /** Section id this setting renders in — must match a SETTINGS_SECTIONS id. */
  sectionId: string;
  /** Settings field name; also the row's `data-settings-key` scroll anchor. */
  key: string;
  /** i18n key for the control's label. */
  labelKey: string;
  /** English label, used as the i18n fallback and for the drift guard. */
  labelFallback: string;
  /** i18n key for the control's help text, when it has any. */
  helpKey?: string;
  /** English help text, used as the i18n fallback. */
  helpFallback?: string;
  /**
   * Synonyms an operator might search that appear nowhere in the control's own
   * copy. Use sparingly: label and help are indexed automatically, so this is
   * only for genuine vocabulary gaps (e.g. "hotkeys" for a control whose copy
   * only ever says "keyboard shortcut"), never for restating the label.
   */
  keywords?: string[];
}

/** A settings entry ranked against a query, carrying its resolved copy. */
export interface SettingsSearchResult extends SettingsSearchEntry {
  /** Locale-resolved label shown in the result row. */
  label: string;
  /** Locale-resolved help, shown as the result's supporting line. */
  help?: string;
  /** Lower is better; see rankSettingsSearchResults for the tiers. */
  score: number;
}
