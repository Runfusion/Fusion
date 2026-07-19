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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/*
FNXC:GitHubImportTranslate 2026-07-15-17:05:
Issues per background request. Small enough that the first translated titles appear quickly instead of after the whole page, large enough not to make 50 issues into 50 round-trips. Each chunk is an independent failure/retry unit.
*/
export const AUTO_TRANSLATE_CHUNK_SIZE = 8;

/*
FNXC:GitHubImportTranslate 2026-07-15-18:40:
Cheap djb2 digest of the items' prose, used ONLY to decide when the panel must re-request (an edited issue keeps its number but must not keep its old translation).
Deliberately not a crypto hash: it runs on every eligible issue and only needs to change when the text changes. The durable server cache keys on a real sha256 of the same content.
*/
export function hashImportItemsForKey(items: AutoTranslateListItem[]): string {
  let hash = 5381;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0;
    }
  };
  for (const item of items) {
    const title = item.title ?? "";
    const body = item.body ?? "";
    /*
    FNXC:GitHubImportTranslate 2026-07-15-19:30:
    LENGTH-PREFIXED, not delimiter-separated (PR #2147 review). Prose may itself contain the delimiter, which made the encoding ambiguous: `{title:"a|b", body:"c"}` and `{title:"a", body:"b|c"}` both rendered `1|a|b|c|`, so moving a `|` between fields produced an unchanged signature and the panel kept serving the OLD translation.
    Prefixing each field with its length makes the encoding injective, so no edit can collide with its own previous content.
    */
    feed(`${item.number}:${title.length}:`);
    feed(title);
    feed(`:${body.length}:`);
    feed(body);
  }
  return hash.toString(36);
}

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
  /** The caller's current client-side page window, never the entire fetched set. */
  items: AutoTranslateListItem[];
  /** Monotonic identity bumped only after a successful issues reload. */
  reloadGeneration: number;
  targetLocale: Locale;
  projectId?: string;
}

export interface GitHubImportAutoTranslateState {
  /** number -> translated fields, accumulated while paging within one reload. */
  translations: Map<number, ImportTranslateFields>;
  loading: boolean;
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
  reloadGeneration,
  targetLocale,
  projectId,
}: UseGitHubImportAutoTranslateArgs): GitHubImportAutoTranslateState {
  const [translations, setTranslations] = useState<Map<number, ImportTranslateFields>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
  FNXC:GitHubImportTranslate 2026-07-15-17:05:
  `items` is a fresh ARRAY IDENTITY on most renders, so neither it nor anything derived from it may sit in the effect's dependency list: the effect calls setState, setState re-renders, the re-render mints a new array, and the effect fires again — an infinite render loop (caught as an OOM under renderHook).
  Everything the effect depends on is therefore reduced to STRING keys (stable by value), and the live issue data is read from a ref at run time instead of being a dependency.
  */
  /*
  FNXC:GitHubImportTranslate 2026-07-17-12:50:
  FN-8230 passes the already-paged window from GitHubImportModal rather than a page index here.
  That keeps this hook independent of the modal's hide-imported filtering while ensuring every
  reachable page is eligible; the retained 50-item slice remains a defensive per-request bound.
  */
  const eligible = useMemo(
    () => items.filter((item) => item.state !== "closed").slice(0, AUTO_TRANSLATE_MAX_ISSUES),
    [items],
  );

  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;
  const translationSignaturesRef = useRef<Map<number, string>>(new Map());

  /*
  FNXC:GitHubImportTranslate 2026-07-15-18:40:
  The key covers issue CONTENT, not just issue numbers (PR #2147 review). Keying on numbers alone meant an edited issue — same number, new prose — produced an unchanged key, so the panel never re-requested and kept showing the translation of the OLD text. The server would have missed its own cache on `sourceHash` and re-translated, but the client never asked.
  `contentSignature` is a cheap non-cryptographic digest: this only has to CHANGE when the prose changes, it is not a security or storage key (the durable cache uses a real sha256 server-side).
  */
  const contentSignature = useMemo(
    () => hashImportItemsForKey(eligible),
    [eligible],
  );

  /* Stable-by-value key: re-runs only when the actual visible page content changes,
     not on unrelated list re-renders. */
  const requestKey = useMemo(
    () =>
      enabled && owner && repo && eligible.length > 0
        ? `${owner}/${repo}|${targetLocale}|${reloadGeneration}|${eligible.map((i) => i.number).join(",")}|${contentSignature}`
        : null,
    [enabled, owner, repo, targetLocale, reloadGeneration, eligible, contentSignature],
  );
  const resetKey = `${enabled ? "on" : "off"}|${owner}/${repo}|${targetLocale}|${reloadGeneration}`;

  /*
  FNXC:GitHubImportTranslate 2026-07-17-12:50:
  Page navigation must accumulate translations, whereas a successful reload, source change, or locale
  change must discard them. Keep this reset separate from the page request effect so an unchanged
  translated issue is never re-billed, but edited prose (new per-item signature) is re-requested.
  */
  useEffect(() => {
    translationSignaturesRef.current.clear();
    setTranslations((prev) => (prev.size > 0 ? new Map() : prev));
    setError((prev) => (prev ? null : prev));
    setLoading((prev) => (prev ? false : prev));
  }, [resetKey]);

  useEffect(() => {
    if (!requestKey) return;

    const pageItems = eligibleRef.current;
    const pending = pageItems.filter((item) => {
      const signature = hashImportItemsForKey([item]);
      return translationSignaturesRef.current.get(item.number) !== signature;
    });
    const staleNumbers = pageItems
      .filter((item) => translationSignaturesRef.current.has(item.number) && translationSignaturesRef.current.get(item.number) !== hashImportItemsForKey([item]))
      .map((item) => item.number);
    if (staleNumbers.length > 0) {
      for (const number of staleNumbers) translationSignaturesRef.current.delete(number);
      setTranslations((prev) => {
        const next = new Map(prev);
        for (const number of staleNumbers) next.delete(number);
        return next;
      });
    }
    if (pending.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setError((prev) => (prev ? null : prev));

    /*
    FNXC:GitHubImportTranslate 2026-07-15-17:05:
    Translation runs in the BACKGROUND and streams in: the list renders immediately in the original language and each chunk's titles swap in as they land. Nothing here is awaited by the issue-list fetch, the preview, or Import.
    Chunked rather than one 50-issue request because a single request only resolves once EVERY issue is translated — on a big page that is minutes of nothing happening, and one timeout would discard the whole page's work. Chunks make progress visible and make a failure cost one chunk instead of all 50.
    Chunks are issued sequentially so a panel open cannot fan 50 model calls at the provider at once (the server already runs 4-way concurrency within a chunk); a cancelled/closed panel stops at the next chunk boundary.
    */
    /*
    FNXC:GitHubImportTranslate 2026-07-15-18:40:
    try/finally, not a `setLoading(false)` after the loop: EVERY exit path must clear the spinner. The server-disabled early return skipped the post-loop clear and left the panel loading forever (PR #2147 review); a `finally` makes that unrepeatable for any future early return too.
    A cancelled run deliberately does NOT touch state — the effect that superseded it owns `loading` now.
    */
    void (async () => {
      try {
      for (let i = 0; i < pending.length; i += AUTO_TRANSLATE_CHUNK_SIZE) {
        if (cancelled) return;
        const chunk = pending.slice(i, i + AUTO_TRANSLATE_CHUNK_SIZE);
        try {
          const response = await autoTranslateImportIssues(
            owner,
            repo,
            chunk.map((item) => ({
              number: item.number,
              title: item.title ?? "",
              body: item.body ?? null,
              state: item.state === "closed" ? "closed" : "open",
            })),
            targetLocale,
            projectId,
          );
          if (cancelled) return;

          // The server is the authority on the setting: an "off" answer stops the run.
          if (response.enabled === false) return;


          const received = Object.entries(response.translations ?? {});
          if (received.length > 0) {
            setTranslations((prev) => {
              const next = new Map(prev);
              for (const [key, value] of received) {
                const number = Number(key);
                if (Number.isInteger(number)) {
                  next.set(number, { title: value.title, body: value.body });
                  const item = chunk.find((candidate) => candidate.number === number);
                  if (item) translationSignaturesRef.current.set(number, hashImportItemsForKey([item]));
                }
              }
              return next;
            });
          }
        } catch (err) {
          if (cancelled) return;
          // Fail soft: keep whatever already landed and surface the error;
          // remaining chunks still get their chance.
          setError(getTranslateErrorMessage(err));
        }
      }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Deps are STRING/scalar only. `requestKey` already encodes repo+locale+issue
    // set; adding `items`/`eligible` (array identities) would re-fire the effect on
    // every render and loop. Live data comes from `eligibleRef`.
  }, [requestKey, owner, repo, targetLocale, projectId]);

  return { translations, loading, error };
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
