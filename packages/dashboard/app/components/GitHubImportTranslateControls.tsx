/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Auto-translation supersedes the original opt-in-only stance below, at operator request. Import panels routinely list issues in languages the operator cannot read, so translation MAY now run automatically — but only when `githubImportAutoTranslate` is switched on (default off), which preserves the faithful-provenance default for anyone who never opts in.
When auto-translate is on: the 50 most recent OPEN foreign-language issues are translated eagerly on list load and shown translated BY DEFAULT, with a toggle back to the original. Translations persist server-side until the issue closes, so re-opening the panel neither waits nor re-bills.
When it is off, behavior is unchanged from 2026-07-14: a manual per-selection offer.

FNXC:GitHubImportTranslate 2026-07-14-12:00:
Import Tasks preview shows translation controls only when selected issue/PR prose is not the dashboard language.
Operators can translate title+body into the active UI locale, toggle original vs translated, or dismiss the offer for the current selection.
Translation is opt-in (never automatic) so import provenance stays faithful until the operator asks. [Superseded 2026-07-15 for the auto-translate path; still the behavior when the setting is off.]
*/

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Languages, Loader2 } from "lucide-react";
import type { Locale } from "@fusion/core";
import {
  translateImportContent,
  getTranslateErrorMessage,
  autoTranslateImportIssues,
} from "../api";
import {
  contentNeedsTranslation,
  localeDisplayName,
  type DetectedContentLanguage,
} from "../utils/detectContentLanguage";

export type ImportTranslateFields = {
  title: string;
  body: string;
};

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
List-level auto-translation. Requirement (2026-07-15): translate the 50 most recent OPEN issues eagerly so the LIST — not just the preview — reads in the operator's language.
Sorting/capping happens here rather than server-side so the cap applies to what the operator can actually see; the server re-applies its own cap as the authority.
Closed issues are excluded outright: their translations are neither created nor kept.
*/
export const AUTO_TRANSLATE_MAX_ISSUES = 50;

export interface AutoTranslateListItem {
  number: number;
  title: string;
  body: string | null;
  state?: "open" | "closed";
}

export interface UseGitHubImportAutoTranslateArgs {
  enabled: boolean;
  owner: string;
  repo: string;
  items: AutoTranslateListItem[];
  targetLocale: Locale;
  projectId?: string;
}

export interface GitHubImportAutoTranslateState {
  /** number -> translated fields, for issues the server translated. */
  translations: Map<number, ImportTranslateFields>;
  loading: boolean;
  /** True when more foreign issues existed than the per-load cap. */
  capped: boolean;
  error: string | null;
}

/**
 * Eagerly translate the visible open issues when auto-translate is enabled.
 * One request per (repo, locale, issue-set); the server serves repeats from its
 * durable cache, so re-opening the panel neither waits nor re-bills.
 */
export function useGitHubImportAutoTranslate({
  enabled,
  owner,
  repo,
  items,
  targetLocale,
  projectId,
}: UseGitHubImportAutoTranslateArgs): GitHubImportAutoTranslateState {
  const [translations, setTranslations] = useState<Map<number, ImportTranslateFields>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the 50 most recent OPEN issues are eligible. GitHub returns issues
  // newest-first, so list order is already "most recent".
  const eligible = useMemo(
    () => items.filter((item) => item.state !== "closed").slice(0, AUTO_TRANSLATE_MAX_ISSUES),
    [items],
  );

  /* Re-run only when the actual issue set changes — not on every list re-render,
     which would re-request on unrelated state churn. */
  const requestKey = useMemo(
    () =>
      enabled && owner && repo && eligible.length > 0
        ? `${owner}/${repo}|${targetLocale}|${eligible.map((i) => i.number).join(",")}`
        : null,
    [enabled, owner, repo, targetLocale, eligible],
  );

  useEffect(() => {
    if (!requestKey) {
      setTranslations(new Map());
      setCapped(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    autoTranslateImportIssues(
      owner,
      repo,
      eligible.map((item) => ({
        number: item.number,
        title: item.title ?? "",
        body: item.body ?? null,
        state: item.state === "closed" ? "closed" : "open",
      })),
      targetLocale,
      projectId,
    )
      .then((response) => {
        if (cancelled) return;
        const next = new Map<number, ImportTranslateFields>();
        for (const [key, value] of Object.entries(response.translations ?? {})) {
          const number = Number(key);
          if (Number.isInteger(number)) {
            next.set(number, { title: value.title, body: value.body });
          }
        }
        setTranslations(next);
        setCapped(Boolean(response.capped));
      })
      .catch((err) => {
        if (cancelled) return;
        // Fail soft: the list still renders in the original language.
        setError(getTranslateErrorMessage(err));
        setTranslations(new Map());
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `requestKey` encodes every input that should retrigger the fetch (repo,
    // locale, issue set); depending on `eligible` directly would refetch on any
    // list re-render.
  }, [requestKey, owner, repo, eligible, targetLocale, projectId]);

  return { translations, loading, capped, error };
}

export type ImportTranslateView = {
  /** Fields currently shown in the preview (original or translated). */
  display: ImportTranslateFields;
  /** True when a foreign-language offer/banner should render. */
  showControls: boolean;
  /** Controls UI element for the banner/toggle row. */
  controls: ReactNode;
  /** Whether the preview is currently showing the translated fields. */
  showingTranslation: boolean;
};

export interface UseGitHubImportTranslationArgs {
  /** Stable key for the selected item (e.g. `issue:12` / `pull:3` / `gitlab:…`). */
  selectionKey: string | null;
  title: string;
  body: string;
  dashboardLocale: Locale;
  projectId?: string;
  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  When auto-translate is on, the selected item's translation is already fetched at list level. Passing it in means the preview shows the translation BY DEFAULT with no second request and no per-selection wait, while the toggle still reveals the untranslated original.
  */
  /** Pre-fetched translation for the current selection (auto-translate mode). */
  autoTranslation?: ImportTranslateFields | null;
  /** Whether auto-translate is enabled for this project. */
  autoTranslateEnabled?: boolean;
}

/**
 * Hook + controls for optional AI translation of import-preview title/body.
 * Caches per-selection translations so re-selecting does not re-bill the AI helper.
 */
export function useGitHubImportTranslation({
  selectionKey,
  title,
  body,
  dashboardLocale,
  projectId,
  autoTranslation = null,
  autoTranslateEnabled = false,
}: UseGitHubImportTranslationArgs): ImportTranslateView {
  const { t } = useTranslation("app");
  const original = useMemo<ImportTranslateFields>(
    () => ({ title: title ?? "", body: body ?? "" }),
    [title, body],
  );

  const detectText = useMemo(
    () => [original.title, original.body].filter(Boolean).join("\n\n"),
    [original.title, original.body],
  );

  const needs = useMemo(
    () => contentNeedsTranslation(detectText, dashboardLocale),
    [detectText, dashboardLocale],
  );

  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => new Set());
  const [cache, setCache] = useState<Map<string, ImportTranslateFields>>(() => new Map());
  const [showingTranslation, setShowingTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Selection change resets to the DEFAULT view for the current mode: translated when auto-translate supplied a translation for this item, original otherwise.
  Requirement: "it should show translated version by default if it's turned on" — so the reset target is mode-dependent, not a hardcoded `false`.
  */
  const hasAutoTranslation = Boolean(autoTranslateEnabled && autoTranslation);
  useEffect(() => {
    setShowingTranslation(hasAutoTranslation);
    setError(null);
    setTranslating(false);
  }, [selectionKey, hasAutoTranslation]);

  // An auto-translation for the current selection takes precedence over any
  // manually fetched one, so both modes read from a single source.
  const cached = autoTranslateEnabled && autoTranslation
    ? autoTranslation
    : selectionKey
      ? cache.get(selectionKey)
      : undefined;
  const dismissed = selectionKey ? dismissedKeys.has(selectionKey) : true;

  /* With a translation already in hand the row is a toggle, not an offer, so it
     shows regardless of the local detector's verdict — the server already
     decided this item was foreign. */
  const showControls = Boolean(
    selectionKey &&
      !dismissed &&
      (hasAutoTranslation || needs.needed) &&
      (original.title.trim() || original.body.trim()),
  );

  const display: ImportTranslateFields =
    showingTranslation && cached
      ? cached
      : original;

  const handleTranslate = useCallback(async () => {
    if (!selectionKey || translating) return;
    setError(null);

    const existing = cache.get(selectionKey);
    if (existing) {
      setShowingTranslation(true);
      return;
    }

    setTranslating(true);
    try {
      const fields = await translateImportContent(
        {
          title: original.title,
          body: original.body,
        },
        dashboardLocale,
        projectId,
        needs.detected.locale !== "unknown" ? needs.detected.locale : undefined,
      );
      const next: ImportTranslateFields = {
        title: fields.title ?? original.title,
        body: fields.body ?? original.body,
      };
      setCache((prev) => {
        const copy = new Map(prev);
        copy.set(selectionKey, next);
        return copy;
      });
      setShowingTranslation(true);
    } catch (err) {
      setError(getTranslateErrorMessage(err));
    } finally {
      setTranslating(false);
    }
  }, [
    selectionKey,
    translating,
    cache,
    original.title,
    original.body,
    dashboardLocale,
    projectId,
    needs.detected.locale,
  ]);

  const handleToggle = useCallback(() => {
    setShowingTranslation((prev) => !prev);
  }, []);

  const handleDismiss = useCallback(() => {
    if (!selectionKey) return;
    setDismissedKeys((prev) => {
      const copy = new Set(prev);
      copy.add(selectionKey);
      return copy;
    });
    setShowingTranslation(false);
    setError(null);
  }, [selectionKey]);

  const controls = showControls ? (
    <GitHubImportTranslateControls
      detected={needs.detected}
      dashboardLocale={dashboardLocale}
      translating={translating}
      hasTranslation={Boolean(cached)}
      showingTranslation={showingTranslation}
      error={error}
      onTranslate={handleTranslate}
      onToggle={handleToggle}
      onDismiss={handleDismiss}
      t={t}
    />
  ) : null;

  return {
    display,
    showControls,
    controls,
    showingTranslation: Boolean(showingTranslation && cached),
  };
}

interface ControlsProps {
  detected: DetectedContentLanguage;
  dashboardLocale: Locale;
  translating: boolean;
  hasTranslation: boolean;
  showingTranslation: boolean;
  error: string | null;
  onTranslate: () => void;
  onToggle: () => void;
  onDismiss: () => void;
  t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string;
}

function GitHubImportTranslateControls({
  detected,
  dashboardLocale,
  translating,
  hasTranslation,
  showingTranslation,
  error,
  onTranslate,
  onToggle,
  onDismiss,
  t,
}: ControlsProps) {
  const sourceLabel =
    detected.locale === "unknown"
      ? t("git.translateUnknownLanguage", "another language")
      : localeDisplayName(detected.locale);
  const targetLabel = localeDisplayName(dashboardLocale);

  return (
    <div
      className="github-import-translate"
      data-testid="github-import-translate"
      role="region"
      aria-label={t("git.translateRegionAriaLabel", "Content translation")}
    >
      <div className="github-import-translate__row">
        <Languages size={14} aria-hidden="true" className="github-import-translate__icon" />
        <span className="github-import-translate__message" data-testid="github-import-translate-message">
          {hasTranslation && showingTranslation
            ? t(
                "git.translateShowingTranslated",
                "Showing translation into {{target}}.",
                { target: targetLabel },
              )
            : hasTranslation
              ? t(
                  "git.translateShowingOriginal",
                  "Showing original ({{source}}).",
                  { source: sourceLabel },
                )
              : t(
                  "git.translateOffer",
                  "This content appears to be in {{source}}. Translate into {{target}}?",
                  { source: sourceLabel, target: targetLabel },
                )}
        </span>
        <div className="github-import-translate__actions">
          {!hasTranslation ? (
            <button
              type="button"
              className="btn btn-sm btn-primary github-import-translate__action"
              data-testid="github-import-translate-action"
              onClick={onTranslate}
              disabled={translating}
            >
              {translating ? (
                <>
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                  {t("git.translateWorking", "Translating…")}
                </>
              ) : (
                t("git.translateAction", "Translate")
              )}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm github-import-translate__action"
              data-testid="github-import-translate-toggle"
              onClick={onToggle}
              disabled={translating}
            >
              {showingTranslation
                ? t("git.translateShowOriginal", "Show original")
                : t("git.translateShowTranslated", "Show translation")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm github-import-translate__dismiss"
            data-testid="github-import-translate-dismiss"
            onClick={onDismiss}
            disabled={translating}
          >
            {t("git.translateDismiss", "Dismiss")}
          </button>
        </div>
      </div>
      {error && (
        <div className="github-import-translate__error" role="alert" data-testid="github-import-translate-error">
          {error}
        </div>
      )}
    </div>
  );
}
