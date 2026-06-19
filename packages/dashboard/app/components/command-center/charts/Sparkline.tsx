import "./charts.css";

export interface SparklineProps {
  values: number[];
  /** Accessible label for the whole sparkline. */
  ariaLabel?: string;
  /** Max value mapped to full height. Defaults to the largest value. */
  max?: number;
}

function safeHeightPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const denom = Number.isFinite(max) && max > 0 ? max : 1;
  return Math.max(0, Math.min(100, (value / denom) * 100));
}

/**
 * Hand-rolled CSS-bar sparkline (mini vertical bar chart). Zero / non-finite
 * values render a 0-height bar, never a NaN height.
 */
export function Sparkline({ values, ariaLabel, max }: SparklineProps) {
  const computedMax = max ?? values.reduce((m, v) => (v > m ? v : m), 0);

  return (
    <div className="cc-sparkline" role="img" aria-label={ariaLabel}>
      {values.map((v, i) => {
        const height = safeHeightPercent(v, computedMax);
        return (
          <div
            // Sparkline points are positional and may repeat values, so the
            // index is the only stable key.
            key={i}
            className="cc-sparkline-bar"
            style={{ height: `${height}%` }}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}
