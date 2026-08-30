import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, RotateCcw, Search } from "lucide-react";
import type { PatchnodeDay, PatchnodeEntry } from "@fusion/core";
import { fetchPatchnode } from "../api";
import { ViewHeader } from "./ViewHeader";
import "./PatchnodeView.css";

export interface PatchnodeViewProps {
  projectId?: string;
  onOpenTaskDetail?: (taskId: string) => void | Promise<void>;
}

const PAGE_SIZE = 50;

function utcDayOffset(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function PatchnodeView({ projectId, onOpenTaskDetail }: PatchnodeViewProps) {
  const { t, i18n } = useTranslation("app");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [days, setDays] = useState<PatchnodeDay[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void fetchPatchnode({ query: debouncedSearch || undefined, limit: PAGE_SIZE }, projectId)
      .then((feed) => {
        if (!active) return;
        setDays(feed.days);
        setLoadedCount(feed.days.reduce((count, day) => count + day.entries.length, 0));
        setHasMore(feed.hasMore);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [debouncedSearch, projectId, retryNonce]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const feed = await fetchPatchnode({ query: debouncedSearch || undefined, limit: PAGE_SIZE, offset: loadedCount }, projectId);
      setDays((current) => {
        const merged = new Map(current.map((day) => [day.day, { ...day, entries: [...day.entries] }]));
        for (const day of feed.days) {
          const existing = merged.get(day.day);
          if (existing) {
            const ids = new Set(existing.entries.map((entry) => entry.entryId));
            existing.entries.push(...day.entries.filter((entry) => !ids.has(entry.entryId)));
            existing.completedCount = existing.entries.filter((entry) => entry.kind === "completed").length;
            existing.revertedCount = existing.entries.filter((entry) => entry.kind === "reverted").length;
          } else {
            merged.set(day.day, { ...day, entries: [...day.entries] });
          }
        }
        return [...merged.values()].sort((left, right) => right.day.localeCompare(left.day));
      });
      setLoadedCount((count) => count + feed.days.reduce((sum, day) => sum + day.entries.length, 0));
      setHasMore(feed.hasMore);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [debouncedSearch, loadedCount, projectId]);

  const today = useMemo(() => utcDayOffset(0), []);
  const yesterday = useMemo(() => utcDayOffset(-1), []);
  const dayLabel = (day: string) => {
    if (day === today) return t("patchnode.today", "Today");
    if (day === yesterday) return t("patchnode.yesterday", "Yesterday");
    return new Intl.DateTimeFormat(i18n.language, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
  };

  const openEntry = (entry: PatchnodeEntry) => {
    try {
      void Promise.resolve(onOpenTaskDetail?.(entry.taskId)).catch(() => undefined);
    } catch {
      // Durable entries may outlive their task; detail lookup is intentionally fail-soft.
    }
  };

  return (
    <section className="patchnode-view" data-testid="patchnode-view" aria-labelledby="patchnode-title">
      <ViewHeader
        icon={History}
        title={t("patchnode.title", "History")}
        titleId="patchnode-title"
        actions={(
          <label className="patchnode-search" role="search">
            <Search aria-hidden="true" />
            <input
              className="input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("patchnode.searchPlaceholder", "Search deliveries")}
              aria-label={t("patchnode.searchAriaLabel", "Search History")}
              data-testid="patchnode-search"
            />
          </label>
        )}
      />
      <div className="patchnode-view__content">
        {loading ? <p className="patchnode-state">{t("patchnode.loading", "Loading History…")}</p> : null}
        {!loading && error ? (
          <div className="card patchnode-state">
            <p>{t("patchnode.error", "History could not be loaded.")}</p>
            <button className="btn" type="button" onClick={() => setRetryNonce((value) => value + 1)}>{t("patchnode.retry", "Retry")}</button>
          </div>
        ) : null}
        {!loading && !error && days.length === 0 ? (
          <div className="card patchnode-state" data-testid="patchnode-empty">
            <History aria-hidden="true" />
            <p>{debouncedSearch ? t("patchnode.noResults", "No deliveries match this search.") : t("patchnode.empty", "Completed work will appear here day by day.")}</p>
          </div>
        ) : null}
        {!loading && !error ? days.map((day) => (
          <section className="patchnode-day" key={day.day} data-testid={`patchnode-day-${day.day}`}>
            <header className="patchnode-day__header">
              <h3>{dayLabel(day.day)}</h3>
              <span>{t("patchnode.entryCount", { count: day.entries.length, defaultValue: "{{count}} entries" })}</span>
            </header>
            <div className="patchnode-day__entries">
              {day.entries.map((entry) => (
                <button
                  className={`card patchnode-entry patchnode-entry--${entry.kind}${entry.revertedAt ? " patchnode-entry--reverted" : ""}`}
                  key={entry.entryId}
                  type="button"
                  onClick={() => openEntry(entry)}
                  data-testid={`patchnode-entry-${entry.entryId}`}
                >
                  <span className="patchnode-entry__meta">
                    <span className="patchnode-entry__task-id">{entry.taskId}</span>
                    {entry.kind === "reverted" ? <span className="patchnode-entry__badge patchnode-entry__badge--cancelled"><RotateCcw aria-hidden="true" />{t("patchnode.cancelled", "Cancelled")}</span> : null}
                    {entry.kind === "completed" && entry.revertedAt ? <span className="patchnode-entry__badge">{t("patchnode.reverted", "Reverted")}</span> : null}
                  </span>
                  <strong>{entry.title}</strong>
                  <span className="patchnode-entry__body">{entry.body}</span>
                </button>
              ))}
            </div>
          </section>
        )) : null}
        {!loading && !error && hasMore ? <button className="btn patchnode-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("patchnode.loadingMore", "Loading…") : t("patchnode.loadMore", "Load more")}</button> : null}
      </div>
    </section>
  );
}
