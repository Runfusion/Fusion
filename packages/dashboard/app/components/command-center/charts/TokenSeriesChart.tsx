import type { TokenTimePoint } from "@fusion/core";
import { formatCount } from "../areas/areaShared";
import "./charts.css";

export interface TokenSeriesChartProps {
  points: TokenTimePoint[];
  ariaLabel: string;
}

function safeHeightPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const denom = Number.isFinite(max) && max > 0 ? max : 1;
  return Math.max(0, Math.min(100, (value / denom) * 100));
}

/**
 * FNXC:CommandCenterCharts 2026-06-18-15:14:
 * Token usage over time must render as a reduced-motion-safe, hand-rolled CSS chart that handles empty, sparse, and all-zero buckets without NaN geometry. Bars are positional because adjacent buckets can repeat labels or totals.
 */
export function TokenSeriesChart({ points, ariaLabel }: TokenSeriesChartProps) {
  const max = points.reduce((m, p) => (p.totalTokens > m ? p.totalTokens : m), 0);

  return (
    <div className="cc-token-series" role="img" aria-label={ariaLabel} data-testid="cc-token-series-chart">
      <div className="cc-token-series-plot">
        {points.length === 0 ? (
          <div className="cc-token-series-empty" aria-hidden="true" data-testid="cc-token-series-empty" />
        ) : (
          points.map((point, i) => {
            const height = safeHeightPercent(point.totalTokens, max);
            const label = `${point.bucket}: ${formatCount(point.totalTokens)}`;
            return (
              <span
                key={i}
                className="cc-token-series-bar"
                style={{ height: `${height}%` }}
                aria-label={label}
                title={label}
              />
            );
          })
        )}
      </div>
      <div className="cc-token-series-axis" aria-hidden="true">
        <span>{points[0]?.bucket ?? "—"}</span>
        <span>{points.at(-1)?.bucket ?? "—"}</span>
      </div>
    </div>
  );
}
