import { useLayoutEffect, useRef, useState } from "react";
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

const FALLBACK_VIEWBOX_WIDTH = 250;
const FALLBACK_VIEWBOX_HEIGHT = 100;
const POINT_RADIUS = 1.8;
const PLOT_PADDING = 3;

interface ChartGeometry {
  width: number;
  height: number;
}

const FALLBACK_GEOMETRY: ChartGeometry = { width: FALLBACK_VIEWBOX_WIDTH, height: FALLBACK_VIEWBOX_HEIGHT };

function safeHeightPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const denom = Number.isFinite(max) && max > 0 ? max : 1;
  return Math.max(0, Math.min(100, (value / denom) * 100));
}

function safeCoord(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function boundedGeometry(width: number, height: number): ChartGeometry | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width: Math.max(width, PLOT_PADDING * 2 + POINT_RADIUS * 2),
    height: Math.max(height, PLOT_PADDING * 2 + POINT_RADIUS * 2),
  };
}

function pointFor(value: number, index: number, count: number, max: number, geometry: ChartGeometry): { x: number; y: number } {
  const plotWidth = Math.max(0, geometry.width - PLOT_PADDING * 2);
  const plotHeight = Math.max(0, geometry.height - PLOT_PADDING * 2);
  const x = count <= 1 ? geometry.width / 2 : PLOT_PADDING + (index / (count - 1)) * plotWidth;
  const height = safeHeightPercent(value, max);
  return {
    x: safeCoord(x),
    y: safeCoord(PLOT_PADDING + plotHeight * (1 - height / 100)),
  };
}

function pointsFor(values: number[], max: number, geometry: ChartGeometry): { x: number; y: number }[] {
  return values.map((value, index) => pointFor(value, index, values.length, max, geometry));
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

function geometryFromRect(rect: Pick<DOMRectReadOnly, "width" | "height">): ChartGeometry | null {
  return boundedGeometry(rect.width, rect.height);
}

function geometriesMatch(left: ChartGeometry, right: ChartGeometry): boolean {
  return Math.abs(left.width - right.width) < 0.5 && Math.abs(left.height - right.height) < 0.5;
}

/**
 * FNXC:CommandCenterCharts 2026-06-18-14:29:
 * Command Center needed a true, zero/NaN-safe, reduced-motion-aware animated line chart for time-series metrics; reuse the Bar/Sparkline safe-height convention so malformed analytics values never leak NaN or Infinity into SVG geometry.
 *
 * FNXC:CommandCenterCharts 2026-06-19-05:24:
 * Activity line charts were clipping max/min points because the data domain mapped to the full SVG viewBox edge. Reserve plot padding equal to the rendered point/stroke margin so populated, single-point, zero, and max-value series stay inside the viewBox on desktop and mobile.
 *
 * FNXC:CommandCenterCharts 2026-06-21-17:10:
 * FN-6883 restores the dual invariant FN-6818 could not satisfy with a square `xMidYMid meet` viewBox: Activity line charts must fill the wide desktop/mobile CSS box without centered blank margins, and markers must remain true circles. Track the rendered SVG box with ResizeObserver and use that measured coordinate system with `preserveAspectRatio="none"`; the fallback matches the desktop 5:2 CSS ratio so first paint and jsdom tests do not reintroduce square letterboxing.
 */
export function LineChart({ series, ariaLabel, max }: LineChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [geometry, setGeometry] = useState<ChartGeometry>(FALLBACK_GEOMETRY);
  const computedMax = computedMaxFor(series, max);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return undefined;
    }

    const updateGeometry = (next: ChartGeometry | null) => {
      if (!next) {
        return;
      }
      setGeometry((current) => (geometriesMatch(current, next) ? current : next));
    };

    updateGeometry(geometryFromRect(svg.getBoundingClientRect()));

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        updateGeometry(geometryFromRect(entry.contentRect));
      }
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    <svg
      ref={svgRef}
      className="cc-line-chart"
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      preserveAspectRatio="none"
    >
      {series.map((entry, seriesIndex) => {
        const points = pointsFor(entry.values, computedMax, geometry);
        const pointString = pointsAttribute(points);
        return (
          <g key={seriesIndex} className="cc-line-chart-series" aria-label={entry.label}>
            {points.length > 1 ? (
              <polyline
                className="cc-line-chart-path"
                points={pointString}
                pathLength={geometry.width}
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
