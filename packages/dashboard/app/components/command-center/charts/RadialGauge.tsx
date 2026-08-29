import type { CSSProperties } from "react";
import "./charts.css";

export interface RadialGaugeProps {
  /** Ratio rendered by the gauge. Values outside 0..1 are clamped. */
  value: number | null;
  /** Visible label below the gauge value. */
  label: string;
  /** Accessible label for the complete gauge. */
  ariaLabel: string;
}

function safeGaugeRatio(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function formatGaugeValue(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const safeValue = safeGaugeRatio(value);
  return `${Math.round(safeValue * 100)}%`;
}

/**
 * CSS conic-gradient radial gauge for Command Center ratios. Null renders as
 * unavailable while non-finite numeric inputs collapse to a safe 0% display,
 * matching the zero/NaN-safe behavior of the hand-rolled chart primitives.
 */
export function RadialGauge({ value, label, ariaLabel }: RadialGaugeProps) {
  const safeValue = safeGaugeRatio(value);
  const valueText = formatGaugeValue(value);
  const style = {
    "--cc-radial-value": `${safeValue * 100}%`,
  } as CSSProperties;

  return (
    <div className="cc-radial-gauge" role="img" aria-label={ariaLabel} style={style}>
      <div className="cc-radial-gauge-ring" aria-hidden="true">
        <div className="cc-radial-gauge-core">
          <span className="cc-radial-gauge-value">{valueText}</span>
        </div>
      </div>
      <span className="cc-radial-gauge-label">{label}</span>
    </div>
  );
}
