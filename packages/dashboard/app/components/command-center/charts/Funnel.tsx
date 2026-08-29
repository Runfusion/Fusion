import "./charts.css";

export interface FunnelStage {
  label: string;
  value: number;
}

export interface FunnelProps {
  stages: FunnelStage[];
  /** Accessible label for the whole funnel. */
  ariaLabel?: string;
}

function safeWidthPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const denom = Number.isFinite(max) && max > 0 ? max : 1;
  return Math.max(0, Math.min(100, (value / denom) * 100));
}

function conversionLabel(value: number, prev: number | null): string | null {
  if (prev === null) {
    return null;
  }
  if (!Number.isFinite(prev) || prev <= 0) {
    return "—";
  }
  const pct = Math.max(0, Math.min(100, (value / prev) * 100));
  return `${pct.toFixed(0)}%`;
}

/**
 * Hand-rolled CSS funnel. The first (largest) stage anchors 100% width; each
 * stage shows its count and conversion from the prior stage. Zero values render
 * a 0-width bar and a "—" conversion, never NaN.
 */
export function Funnel({ stages, ariaLabel }: FunnelProps) {
  const max = stages.reduce((m, s) => (s.value > m ? s.value : m), 0);

  return (
    <ol className="cc-funnel" aria-label={ariaLabel}>
      {stages.map((s, i) => {
        const width = safeWidthPercent(s.value, max);
        const prev = i > 0 ? stages[i - 1].value : null;
        const conversion = conversionLabel(s.value, prev);
        const valueText = String(Number.isFinite(s.value) ? s.value : 0);
        return (
          <li key={s.label} className="cc-funnel-stage">
            <div className="cc-funnel-header">
              <span className="cc-funnel-label">{s.label}</span>
              {conversion !== null ? <span className="cc-funnel-conversion">{conversion}</span> : null}
            </div>
            <div className="cc-funnel-track">
              <div
                className="cc-funnel-fill"
                style={{ width: `${width}%` }}
                role="img"
                aria-label={`${s.label}: ${valueText}`}
              />
            </div>
            <span className="cc-funnel-value">{valueText}</span>
          </li>
        );
      })}
    </ol>
  );
}
