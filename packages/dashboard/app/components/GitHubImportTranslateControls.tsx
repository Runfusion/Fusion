/*
FNXC:GitHubImportTranslate 2026-07-14-12:00:
Import Tasks preview shows translation controls only when selected issue/PR prose is not the dashboard language.
Operators can translate title+body into the active UI locale, toggle original vs translated, or dismiss the offer for the current selection.
Translation is opt-in (never automatic) so import provenance stays faithful until the operator asks.
*/

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Languages, Loader2 } from "lucide-react";
import type { Locale } from "@fusion/core";
import { translateImportContent, getTranslateErrorMessage } from "../api";
import {
  contentNeedsTranslation,
  localeDisplayName,
  type DetectedContentLanguage,
} from "../utils/detectContentLanguage";

export type ImportTranslateFields = {
  title: string;
  body: string;
};

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

  // Reset view mode when selection changes; keep cache and dismissals.
  useEffect(() => {
    setShowingTranslation(false);
    setError(null);
    setTranslating(false);
  }, [selectionKey]);

  const cached = selectionKey ? cache.get(selectionKey) : undefined;
  const dismissed = selectionKey ? dismissedKeys.has(selectionKey) : true;

  const showControls = Boolean(
    selectionKey &&
      needs.needed &&
      !dismissed &&
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
