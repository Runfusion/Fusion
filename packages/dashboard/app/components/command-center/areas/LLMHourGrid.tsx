/*
FNXC:LaneTelemetry 2026-11-04-05:09 (R1/R5/R6):
The honeycomb plate for LLM lane telemetry: one row per lane, one column per model, plus the aggregate
columns that make a cache regression readable (cache-read share, distinct prompt-head hashes, median
system bytes, divergences). Three rules the rest of the panel already agreed to and this surface must not
break:

1. It renders a THIRD accounting source. Its numbers come from `usage_events` only and the section is
   never summed with the task/chat totals printed above it, so it is captioned with its own window
   boundaries and its own header, not folded into the Totals cards.
2. Honest absence. A lane whose provider never reported a cache-read counter renders as "unmeasured",
   never as 0% — a computed zero reads as "no cache hits" and would send an operator chasing a bug that
   does not exist.
3. Nothing is hard-coded to a lane or hour count. Lanes and models come from the payload, because the
   lane set grows (and a fifth engine lane is expected) and a fixed grid silently drops whatever it does
   not know about.

FNXC:LaneTelemetry 2026-11-04-07:20:
Every spend tile is a real button and clicking one filters the prompt-head list below the plate, because
the operator's next question after "this lane spent 2M tokens" is "what did it send?" — a tile that is a
`<td>` cannot be pressed, and a head list with no filter cannot be read. The filter is per LANE, not per
cell: a `prompt_head` row records the head a lane sent and carries no model column, so a model-scoped
filter would silently show rows that were not that model's. Selection stays a lane predicate on purpose.
*/
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { LlmTelemetryGridCell, LlmTelemetryHeadEvent, LlmTelemetryReport } from "@fusion/core";
import { ProviderIcon } from "../../ProviderIcon";
import { inferProviderIconKey } from "../../../utils/providerIconKey";
import { formatCount } from "./areaShared";
import "./LLMHourGrid.css";

function shareLabel(share: number | null): string {
  return share === null ? "" : `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
}

function cellIdentity(lane: string, model: string | null): string {
  return `${lane}\u0000${model ?? ""}`;
}

/** Short, still-unique-enough digest prefix; the full hash is in the expanded detail. */
function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 12) : "—";
}

function timeLabel(ts: string): string {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : "—";
}

/** One `prompt_head` row: identity and sizes only — the head text was never stored, so it cannot render. */
function HeadRow({ head }: { head: LlmTelemetryHeadEvent }) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const detailId = `cc-llm-head-detail-${head.id}`;
  return (
    <li className="cc-llm-head-row" data-testid={`cc-llm-head-${head.id}`}>
      <button
        type="button"
        className="cc-llm-head-toggle"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={t("commandCenter.llmTelemetry.head.toggleLabel", {
          lane: head.lane,
          hash: shortHash(head.headHash),
          defaultValue: "{{lane}} head {{hash}} — show sizes, offsets and provenance",
        })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="cc-llm-head-time">{timeLabel(head.ts)}</span>
        <span className="cc-llm-head-lane">{head.lane}</span>
        <code className="cc-llm-head-hash">{shortHash(head.headHash)}</code>
        <span className="cc-llm-head-bytes">{head.headBytes === null ? "—" : formatCount(head.headBytes)}</span>
        <span className={`cc-llm-head-divergence cc-llm-head-divergence-${head.divergenceStatus ?? "unknown"}`}>
          {head.divergenceStatus ?? "—"}
          {head.firstDivergenceOffset !== null ? ` @${head.firstDivergenceOffset}` : ""}
        </span>
      </button>
      {open ? (
        <dl className="cc-llm-head-detail" id={detailId}>
          <dt>{t("commandCenter.llmTelemetry.head.hash", "Head hash (sha256)")}</dt>
          <dd><code>{head.headHash ?? "—"}</code></dd>
          <dt>{t("commandCenter.llmTelemetry.head.staticBytes", "Static bytes")}</dt>
          <dd>{head.staticBytes ?? "—"}</dd>
          <dt>{t("commandCenter.llmTelemetry.head.dynamicBytes", "Dynamic bytes")}</dt>
          <dd>{head.dynamicBytes ?? "—"}</dd>
          <dt>{t("commandCenter.llmTelemetry.head.dynamicStart", "Dynamic start")}</dt>
          <dd>{head.dynamicStart ?? "—"}</dd>
          <dt>{t("commandCenter.llmTelemetry.head.firstDivergenceOffset", "First divergence offset")}</dt>
          <dd>{head.firstDivergenceOffset ?? "—"}</dd>
          <dt>{t("commandCenter.llmTelemetry.head.source", "Source")}</dt>
          <dd>{head.source ?? "—"}</dd>
          <dt>{t("commandCenter.llmTelemetry.head.runtime", "Runtime")}</dt>
          <dd>{head.runtimeId ?? "—"}</dd>
          <dt>{t("commandCenter.llmTelemetry.head.request", "Request id")}</dt>
          <dd><code>{head.requestId ?? "—"}</code></dd>
        </dl>
      ) : null}
    </li>
  );
}

/**
 * Lane × model plate with per-lane aggregates and window-level footer totals.
 *
 * The caller owns the fetch and the empty branch; this component assumes a payload exists and renders
 * whatever lanes and models it names.
 */
export function LLMHourGrid({ report }: { report: LlmTelemetryReport }) {
  const { t } = useTranslation("app");
  const unmeasuredLabel = t("commandCenter.llmTelemetry.unmeasured", "unmeasured");
  const [selectedLane, setSelectedLane] = useState<string | null>(null);

  const models = useMemo(() => {
    const byModel = new Map<string, { label: string | null; total: number }>();
    for (const cell of report.grid) {
      const key = cell.model ?? "";
      const prev = byModel.get(key);
      byModel.set(key, { label: cell.model, total: (prev?.total ?? 0) + cell.totalTokens });
    }
    return [...byModel.values()].sort((a, b) => b.total - a.total || (a.label ?? "").localeCompare(b.label ?? ""));
  }, [report.grid]);

  const cells = useMemo(() => {
    const map = new Map<string, LlmTelemetryGridCell>();
    for (const cell of report.grid) map.set(cellIdentity(cell.lane, cell.model), cell);
    return map;
  }, [report.grid]);

  const maxCellTokens = useMemo(
    () => report.grid.reduce((max, cell) => Math.max(max, cell.totalTokens), 0),
    [report.grid],
  );

  // Head evidence is lane-scoped (a `prompt_head` row has no model column), so the filter is a lane.
  const headRows = useMemo(
    () => (selectedLane ? report.headEvents.filter((head) => head.lane === selectedLane) : report.headEvents),
    [report.headEvents, selectedLane],
  );

  return (
    <div className="cc-llm" data-testid="cc-llm-grid">
      <div className="cc-llm-scroll">
        <table className="cc-llm-table">
          <caption className="cc-llm-caption">
            {t(
              "commandCenter.llmTelemetry.windowCaption",
              {
                from: new Date(report.from).toLocaleTimeString(),
                to: new Date(report.to).toLocaleTimeString(),
                defaultValue:
                  "usage_events from {{from}} to {{to}} — a separate accounting source, never added to the totals above",
              },
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="cc-llm-lane-col">
                {t("commandCenter.llmTelemetry.lane", "Lane")}
              </th>
              {models.map((model) => (
                <th scope="col" key={model.label ?? "unknown"} className="cc-llm-model-col">
                  <span className="cc-model-label">
                    <ProviderIcon provider={inferProviderIconKey(model.label ?? "")} size="sm" />
                    <span className="cc-model-label-text">{model.label ?? t("commandCenter.llmTelemetry.unknownModel", "(unknown)")}</span>
                  </span>
                </th>
              ))}
              <th scope="col" className="cc-llm-agg-col">
                {t("commandCenter.llmTelemetry.cacheShare", "Cache-read share")}
              </th>
              <th scope="col" className="cc-llm-agg-col">
                {t("commandCenter.llmTelemetry.distinctHeads", "Distinct heads")}
              </th>
              <th scope="col" className="cc-llm-agg-col">
                {t("commandCenter.llmTelemetry.medianHeadBytes", "Median system bytes")}
              </th>
              <th scope="col" className="cc-llm-agg-col">
                {t("commandCenter.llmTelemetry.divergences", "Prompt divergences")}
              </th>
            </tr>
          </thead>
          <tbody>
            {report.aggregates.map((aggregate) => {
              const { divergenceCounts, offsetBucketCounts, offsetUnknownCount, medianHeadBytes } = aggregate.head;
              const divergenceHint = t("commandCenter.llmTelemetry.divergenceHint", {
                baselineCount: divergenceCounts.baseline,
                identicalCount: divergenceCounts.identical,
                unknownCount: offsetUnknownCount,
                defaultValue: "Baseline {{baselineCount}}, identical {{identicalCount}}, offsets unknown for {{unknownCount}}",
              });
              return (
                <tr key={aggregate.lane} data-testid={`cc-llm-row-${aggregate.lane}`}>
                  <th scope="row" className="cc-llm-lane-col">
                    <span className="cc-llm-lane-name">{aggregate.lane}</span>
                    <span className="cc-llm-lane-sub">
                      {t("commandCenter.llmTelemetry.requests", "{{n}} requests", { n: aggregate.tokens.requestCount })}
                    </span>
                  </th>
                  {models.map((model) => {
                    const cell = cells.get(cellIdentity(aggregate.lane, model.label));
                    const tokens = cell?.totalTokens ?? 0;
                    const heat = maxCellTokens > 0 ? tokens / maxCellTokens : 0;
                    const pressed = selectedLane === aggregate.lane && tokens > 0;
                    return (
                      <td
                        key={model.label ?? "unknown"}
                        className={`cc-llm-cell${tokens > 0 ? "" : " cc-llm-cell-empty"}`}
                        style={{ "--cc-llm-heat": heat } as CSSProperties}
                        data-testid={`cc-llm-cell-${aggregate.lane}-${model.label ?? "unknown"}`}
                      >
                        {tokens > 0 ? (
                          <button
                            type="button"
                            className="cc-llm-tile"
                            aria-pressed={pressed}
                            onClick={() => setSelectedLane((current) => (current === aggregate.lane ? null : aggregate.lane))}
                            aria-label={t("commandCenter.llmTelemetry.tileLabel", {
                              lane: aggregate.lane,
                              model: model.label ?? t("commandCenter.llmTelemetry.unknownModel", "(unknown)"),
                              tokens: formatCount(tokens),
                              events: cell?.eventCount ?? 0,
                              defaultValue: "{{lane}} on {{model}}: {{tokens}} tokens over {{events}} requests. Show this lane's prompt heads.",
                            })}
                          >
                            {formatCount(tokens)}
                          </button>
                        ) : (
                          "·"
                        )}
                      </td>
                    );
                  })}
                  <td className="cc-llm-agg-col">
                    {aggregate.cacheReadShare === null ? (
                      <span className="cc-llm-unmeasured" title={t("commandCenter.llmTelemetry.cacheShareHint", "No provider in this lane reported cache reads")}>
                        {unmeasuredLabel}
                      </span>
                    ) : (
                      shareLabel(aggregate.cacheReadShare)
                    )}
                  </td>
                  <td className="cc-llm-agg-col">{formatCount(aggregate.head.distinctHeadHashCount)}</td>
                  <td className="cc-llm-agg-col">
                    {medianHeadBytes === null ? unmeasuredLabel : formatCount(medianHeadBytes)}
                  </td>
                  <td className="cc-llm-agg-col">
                    <span
                      className={divergenceCounts.diverged > 0 ? "cc-llm-diverged" : undefined}
                      title={divergenceHint}
                      data-testid={`cc-llm-divergence-${aggregate.lane}`}
                    >
                      {formatCount(divergenceCounts.diverged)}
                    </span>
                    <span className="cc-llm-offset-buckets">
                      {t("commandCenter.llmTelemetry.offsetBuckets", {
                        known: Object.values(offsetBucketCounts).reduce((sum, n) => sum + n, 0),
                        unknown: offsetUnknownCount,
                        defaultValue: "{{known}} localised, {{unknown}} not",
                      })}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="cc-llm-footer">
        <div className="cc-llm-stat" data-testid="cc-llm-prompt-tokens">
          <span className="cc-llm-stat-label">{t("commandCenter.llmTelemetry.promptTokens", "Prompt tokens (all lanes)")}</span>
          <span className="cc-llm-stat-value">{formatCount(report.totalPromptTokens)}</span>
        </div>
        <div className="cc-llm-stat" data-testid="cc-llm-heartbeat-share">
          <span className="cc-llm-stat-label">{t("commandCenter.llmTelemetry.heartbeatShare", "Heartbeat share")}</span>
          <span className="cc-llm-stat-value">
            {report.heartbeatPromptTokenShare === null
              ? unmeasuredLabel
              : shareLabel(report.heartbeatPromptTokenShare)}
          </span>
        </div>
        {report.gridTruncated || report.headTruncated ? (
          <span className="cc-llm-truncated" data-testid="cc-llm-truncated">
            {t("commandCenter.llmTelemetry.truncated", "Window too large — counts are partial")}
          </span>
        ) : null}
      </div>

      {/*
      FNXC:LaneTelemetry 2026-11-04-07:20:
      The head list is capped and scrolls instead of growing the page: the Tokens area is one section of a
      dashboard, and a busy hour of per-request heads would otherwise push every other section away.
      */}
      <div className="cc-llm-heads" data-testid="cc-llm-heads">
        <div className="cc-llm-heads-header">
          <h4 className="cc-llm-heads-title">{t("commandCenter.llmTelemetry.heads.title", "Prompt heads in this window")}</h4>
          {selectedLane ? (
            <button
              type="button"
              className="btn btn-sm cc-llm-heads-clear"
              data-testid="cc-llm-heads-clear"
              onClick={() => setSelectedLane(null)}
            >
              {t("commandCenter.llmTelemetry.heads.clear", "Clear lane filter ({{lane}})", { lane: selectedLane })}
            </button>
          ) : null}
        </div>
        {headRows.length > 0 ? (
          <ul className="cc-llm-head-list" aria-label={t("commandCenter.llmTelemetry.heads.listLabel", "Prompt head records")}>
            {headRows.map((head) => <HeadRow key={head.id} head={head} />)}
          </ul>
        ) : (
          <p className="cc-llm-empty" data-testid="cc-llm-heads-empty">
            {selectedLane
              ? t("commandCenter.llmTelemetry.heads.emptyLane", "No prompt head recorded for {{lane}} in this window", { lane: selectedLane })
              : t("commandCenter.llmTelemetry.heads.empty", "No prompt head recorded in this window")}
          </p>
        )}
      </div>
    </div>
  );
}
