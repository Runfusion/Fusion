import "./charts.css";

export interface LineChartSeries {
  label: string;
  values: number[];
}

export interface LineChartProps {
  /** One or more named time-series rendered against the same 0..max scale. */
  series: LineChartSeries[];
  /** Accessible label for the whole chart. */
  ariaLabel?: string;
  /** Max value mapped to full height. Defaults to the largest finite series value. */
  max?: number;
}

const VIEWBOX_SIZE = 100;
const SINGLE_POINT_X = VIEWBOX_SIZE / 2;
const POINT_RADIUS = 1.8;
const PLOT_PADDING = 3;
const PLOT_SIZE = VIEWBOX_SIZE - PLOT_PADDING * 2;

function safeHeightPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const denom = Number.isFinite(max) && max > 0 ? max : 1;
  return Math.max(0, Math.min(VIEWBOX_SIZE, (value / denom) * VIEWBOX_SIZE));
}

function safeCoord(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function pointFor(value: number, index: number, count: number, max: number): { x: number; y: number } {
  const x = count <= 1 ? SINGLE_POINT_X : PLOT_PADDING + (index / (count - 1)) * PLOT_SIZE;
  const height = safeHeightPercent(value, max);
  return {
    x: safeCoord(x),
    y: safeCoord(PLOT_PADDING + PLOT_SIZE * (1 - height / VIEWBOX_SIZE)),
  };
}

function pointsFor(values: number[], max: number): { x: number; y: number }[] {
  return values.map((value, index) => pointFor(value, index, values.length, max));
}

function pointsAttribute(points: { x: number; y: number }[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function computedMaxFor(series: LineChartSeries[], max?: number): number {
  if (Number.isFinite(max) && max !== undefined && max > 0) {
    return max;
  }
  return series.reduce((largest, next) => {
    const seriesMax = next.values.reduce(
      (innerLargest, value) => (Number.isFinite(value) && value > innerLargest ? value : innerLargest),
      0,
    );
    return seriesMax > largest ? seriesMax : largest;
  }, 0);
}

/**
 * FNXC:CommandCenterCharts 2026-06-18-14:29:
 * Command Center needed a true, zero/NaN-safe, reduced-motion-aware animated line chart for time-series metrics; reuse the Bar/Sparkline safe-height convention so malformed analytics values never leak NaN or Infinity into SVG geometry.
 *
 * FNXC:CommandCenterCharts 2026-06-19-05:24:
 * Activity line charts were clipping max/min points because the data domain mapped to the full SVG viewBox edge. Reserve plot padding equal to the rendered point/stroke margin so populated, single-point, zero, and max-value series stay inside the viewBox on desktop and mobile.
 *
 * FNXC:CommandCenterCharts 2026-06-20-22:59:
 * FN-6818 requires Activity markers to render as true circles independent of the chart container's aspect ratio. `preserveAspectRatio="none"` on the square viewBox stretched circle coordinates into ovals on narrow/mobile layouts; `vectorEffect="non-scaling-stroke"` only protects stroke width, not coordinate geometry, so the SVG must use uniform scaling.
 */
export function LineChart({ series, ariaLabel, max }: LineChartProps) {
  const computedMax = computedMaxFor(series, max);

  return (
    <svg
      className="cc-line-chart"
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {series.map((entry, seriesIndex) => {
        const points = pointsFor(entry.values, computedMax);
        const pointString = pointsAttribute(points);
        return (
          <g key={seriesIndex} className="cc-line-chart-series" aria-label={entry.label}>
            {points.length > 1 ? (
              <polyline
                className="cc-line-chart-path"
                points={pointString}
                pathLength={VIEWBOX_SIZE}
                vectorEffect="non-scaling-stroke"
                aria-hidden="true"
              />
            ) : null}
            {points.map((point, pointIndex) => (
              <circle
                key={pointIndex}
                className="cc-line-chart-point"
                cx={point.x}
                cy={point.y}
                r={POINT_RADIUS}
                vectorEffect="non-scaling-stroke"
                aria-hidden="true"
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}
