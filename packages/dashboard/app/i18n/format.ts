import { useMemo } from "react";
import { useTranslation } from "react-i18next";

export interface CompactLifecycleDate {
  compact: string;
  full: string;
  dateTime: string;
}

/**
 * Formats lifecycle timestamps against the viewer's local calendar, rather than
 * UTC date boundaries. Invalid and missing legacy values intentionally produce
 * no model so callers never render an Invalid Date shell.
 */
export function formatCompactLifecycleDate(
  value: string | undefined,
  locale: string,
  now: Date = new Date(),
): CompactLifecycleDate | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return null;

  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const compact = sameDay
    ? new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    }).format(date);

  return {
    compact,
    full: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date),
    dateTime: date.toISOString(),
  };
}

/**
 * Locale-aware date/number formatting bound to the active i18n locale.
 *
 * Replaces the ~45 `toLocale*(undefined, …)` call sites that previously used
 * the implicit browser locale. Routing them through this hook threads the
 * user's chosen language into all date/number formatting (R8).
 */
export function useLocaleFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || "en";

  // Memoized per locale so the formatter identities stay stable across
  // renders — consumers can safely put them in hook dependency arrays.
  return useMemo(
    () => ({
      locale,
      formatDate: (value: number | string | Date, options?: Intl.DateTimeFormatOptions) =>
        new Date(value).toLocaleDateString(locale, options),
      formatTime: (value: number | string | Date, options?: Intl.DateTimeFormatOptions) =>
        new Date(value).toLocaleTimeString(locale, options),
      formatDateTime: (value: number | string | Date, options?: Intl.DateTimeFormatOptions) =>
        new Date(value).toLocaleString(locale, options),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        value.toLocaleString(locale, options),
    }),
    [locale],
  );
}
