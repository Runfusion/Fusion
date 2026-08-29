import { ProviderIcon } from "../../ProviderIcon";
import "./charts.css";

/*
 * FNXC:CommandCenterModelLabels 2026-06-25-00:00:
 * Command Center model-heavy bar analytics must render provider marks immediately before model names. Keep provider icons opt-in on BarDatum so non-model chart rows (tool categories, activity series, plugin labels) continue rendering as plain strings with no provider icon shell.
 */
function hasIconProvider(datum: BarDatum): boolean {
  return Object.prototype.hasOwnProperty.call(datum, "iconProvider");
}

export interface BarDatum {
  label: string;
  value: number;
  /** Optional display string for the value (defaults to the number). */
  valueLabel?: string;
  /** Optional ProviderIcon provider key for model-name rows; omitted for non-model charts. */
  iconProvider?: string;
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
      {data.map((d, index) => {
        const width = safeWidthPercent(d.value, computedMax);
        const valueText = d.valueLabel ?? String(Number.isFinite(d.value) ? d.value : 0);
        const labelText = d.label;
        const iconLabelText = d.iconProvider && d.iconProvider !== labelText ? `${d.iconProvider} ${labelText}` : labelText;
        const accessibleLabel = hasIconProvider(d) ? iconLabelText : labelText;
        return (
          <li key={`${accessibleLabel}-${d.value}-${index}`} className="cc-bar-row">
            <span className="cc-bar-label">
              {hasIconProvider(d) ? <ProviderIcon provider={d.iconProvider ?? ""} size="sm" /> : null}
              <span className="cc-bar-label-text">{d.label}</span>
            </span>
            <div className="cc-bar-track">
              <div
                className="cc-bar-fill"
                style={{ width: `${width}%` }}
                role="img"
                aria-label={`${accessibleLabel}: ${valueText}`}
              />
            </div>
            <span className="cc-bar-value">{valueText}</span>
          </li>
        );
      })}
    </ul>
  );
}
