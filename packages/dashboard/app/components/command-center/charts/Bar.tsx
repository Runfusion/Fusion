import "./charts.css";

export interface BarDatum {
  label: string;
  value: number;
  /** Optional display string for the value (defaults to the number). */
  valueLabel?: string;
}

export interface BarProps {
  data: BarDatum[];
  /**
   * Max value mapped to 100% width. Defaults to the largest datum value.
   * Always coerced to at least 1 so a zero-only dataset never divides by zero.
   */
  max?: number;
  /** Accessible label for the whole chart. */
  ariaLabel?: string;
}

function safeWidthPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const denom = Number.isFinite(max) && max > 0 ? max : 1;
  return Math.max(0, Math.min(100, (value / denom) * 100));
}

/**
 * Hand-rolled CSS horizontal bar chart. Zero-value bars render a 0-width bar
 * with an accessible label rather than NaN.
 */
export function Bar({ data, max, ariaLabel }: BarProps) {
  const computedMax = max ?? data.reduce((m, d) => (d.value > m ? d.value : m), 0);

  return (
    <ul className="cc-bar-chart" role="list" aria-label={ariaLabel}>
      {data.map((d) => {
        const width = safeWidthPercent(d.value, computedMax);
        const valueText = d.valueLabel ?? String(Number.isFinite(d.value) ? d.value : 0);
        return (
          <li key={d.label} className="cc-bar-row">
            <span className="cc-bar-label">{d.label}</span>
            <div className="cc-bar-track">
              <div
                className="cc-bar-fill"
                style={{ width: `${width}%` }}
                role="img"
                aria-label={`${d.label}: ${valueText}`}
              />
            </div>
            <span className="cc-bar-value">{valueText}</span>
          </li>
        );
      })}
    </ul>
  );
}
