import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ExternalLink, Loader2, MinusCircle, RefreshCw, XCircle } from "lucide-react";
import type { PrCheckStatus } from "../api";
import "./PrChecksList.css";

interface PrChecksListProps {
  checks: PrCheckStatus[];
  rollup: string;
  lastCheckedAt?: string;
  loading: boolean;
  error?: string | null;
  onRefresh: () => void;
}

const FAILING_STATES = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
const PENDING_STATES = new Set(["pending", "stale"]);

function getCheckPriority(check: PrCheckStatus): number {
  if (FAILING_STATES.has(check.state)) return check.required ? 0 : 1;
  if (PENDING_STATES.has(check.state)) return 2;
  if (check.state === "success" || check.state === "neutral" || check.state === "skipped") return 3;
  return 4;
}

function formatDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.floor((end - start) / 1000);
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

/*
 * FNXC:RelativeTime 2026-06-17-20:48:
 * FN-6618 keeps PR check freshness local because this surface requires seconds-granularity `updated Ns ago` copy and null for empty/unparseable values, which getRelativeTimeBucket does not express.
 */
function relativeTime(value?: string): string | null {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return `updated ${delta}s ago`;
}

export function PrChecksList({ checks, rollup: _rollup, lastCheckedAt, loading, error, onRefresh }: PrChecksListProps) {
  const { t } = useTranslation("app");
  const sortedChecks = useMemo(() => [...checks].sort((a, b) => {
    const byPriority = getCheckPriority(a) - getCheckPriority(b);
    if (byPriority !== 0) return byPriority;
    return a.name.localeCompare(b.name);
  }), [checks]);

  const summary = useMemo(() => {
    return checks.reduce(
      (acc, check) => {
        if (FAILING_STATES.has(check.state)) acc.failing += 1;
        else if (PENDING_STATES.has(check.state)) acc.pending += 1;
        else acc.passing += 1;
        return acc;
      },
      { passing: 0, failing: 0, pending: 0 },
    );
  }, [checks]);

  return (
    <section className="pr-checks" aria-live="polite">
      <div className="pr-checks__header">
        <div className="pr-checks__summary">{t("git.prChecks.summary", "{{passing}} passing, {{failing}} failing, {{pending}} pending", { passing: summary.passing, failing: summary.failing, pending: summary.pending })}</div>
        <div className="pr-checks__header-actions">
          {lastCheckedAt ? <span className="pr-checks__updated">{relativeTime(lastCheckedAt)}</span> : null}
          <button className="btn btn-sm btn-icon" aria-label={t("git.prChecks.refreshAriaLabel", "Refresh checks")} onClick={onRefresh}>
            {loading ? <Loader2 className="spin" /> : <RefreshCw />}
          </button>
        </div>
      </div>

      {error ? (
        <div className="pr-checks__error" role="alert">
          <span>{error}</span>
          <button className="btn btn-sm" onClick={onRefresh}>{t("git.prChecks.retry", "Retry")}</button>
        </div>
      ) : null}

      {sortedChecks.length === 0 ? (
        <div className="pr-checks__empty">{t("git.prChecks.empty", "No checks reported yet")}</div>
      ) : (
        <div className="pr-checks__list" role="list">
          {sortedChecks.map((check) => {
            const failing = FAILING_STATES.has(check.state);
            const pending = PENDING_STATES.has(check.state);
            const duration = formatDuration(check.startedAt, check.completedAt);
            return (
              <div
                key={`${check.name}-${check.state}-${check.required ? "required" : "optional"}`}
                className="pr-checks__item"
                role="listitem"
                aria-label={`${check.state} check ${check.name}`}
              >
                <span className="pr-checks__icon" aria-hidden="true">
                  {failing ? <XCircle /> : pending ? <Loader2 className="spin" /> : check.state === "success" ? <CheckCircle2 /> : <MinusCircle />}
                </span>
                <div className="pr-checks__name-wrap">
                  <span className="pr-checks__name">{check.name}</span>
                  {check.required ? <span className="pr-checks__required">{t("git.prChecks.required", "Required")}</span> : null}
                  {duration ? <span className="pr-checks__duration">{duration}</span> : null}
                </div>
                {check.detailsUrl ? (
                  <a
                    href={check.detailsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={failing ? "pr-checks__details-link pr-checks__details-link--failing" : "pr-checks__details-link"}
                  >
                    {t("git.prChecks.viewDetails", "View details")} <ExternalLink />
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
