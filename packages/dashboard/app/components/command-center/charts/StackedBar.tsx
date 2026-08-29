import "./charts.css";

export interface StackedSegment {
  label: string;
  value: number;
  /** CSS color (e.g. a var(--...) token). */
  color?: string;
}

export interface StackedBarProps {
  segments: StackedSegment[];
  /** Accessible label for the whole bar. */
  ariaLabel?: string;
}

function safeShare(value: number, total: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (value / total) * 100));
}

/**
 * Hand-rolled single horizontal stacked bar. A zero-value segment renders a
 * 0-width slice (still keyed + labelled) rather than NaN. An all-zero set
 * renders an empty track.
 */
export function StackedBar({ segments, ariaLabel }: StackedBarProps) {
  const total = segments.reduce((sum, s) => (Number.isFinite(s.value) && s.value > 0 ? sum + s.value : sum), 0);

  return (
    <div className="cc-stacked-bar" role="img" aria-label={ariaLabel}>
      <div className="cc-stacked-track">
        {segments.map((s) => {
          const share = safeShare(s.value, total);
          return (
            <div
              key={s.label}
              className="cc-stacked-segment"
              style={{ width: `${share}%`, backgroundColor: s.color }}
              aria-label={`${s.label}: ${Number.isFinite(s.value) ? s.value : 0}`}
            />
          );
        })}
      </div>
      <ul className="cc-stacked-legend" role="list">
        {segments.map((s) => (
          <li key={s.label} className="cc-stacked-legend-item">
            <span className="cc-stacked-swatch" style={{ backgroundColor: s.color }} aria-hidden="true" />
            <span>{s.label}</span>
            <strong>{Number.isFinite(s.value) ? s.value : 0}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
