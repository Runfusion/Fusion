import {
  CartesianGrid,
  Legend,
  Line,
  LineChart as RechartsLineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLayoutEffect, useRef, useState } from "react";
import { getCommandCenterChartColor, getCommandCenterChartTheme } from "./theme";
import "../charts.css";

export interface LineChartSeries {
  label: string;
  values: number[];
}

export interface LineChartProps {
  series: LineChartSeries[];
  ariaLabel: string;
  width?: number | string;
  height?: number | string;
  emptyLabel?: string;
  xAxisLabels?: string[];
  valueFormatter?: (value: number) => string;
  /**
   * `shared` keeps comparable values on one absolute axis. `series` normalizes each series to its own max so mixed-unit trends remain legible.
   */
  scaleMode?: "shared" | "series";
}

interface SanitizedLineChartSeries {
  label: string;
  dataKey: string;
  values: number[];
  plotKey: string;
  plotValues: number[];
}

type LineChartPoint = { index: number } & Record<string, number>;
type ResponsiveDimension = number | `${number}%`;
type ChartDimensions = { width: number; height: number };

const FALLBACK_CHART_DIMENSIONS: ChartDimensions = { width: 360, height: 220 };
const MIN_USABLE_CHART_WIDTH = 120;
const MIN_USABLE_CHART_HEIGHT = 120;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function sanitizeLineValue(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeSeriesValues(values: number[]): number[] {
  const max = values.reduce((largest, value) => (value > largest ? value : largest), 0);
  if (max <= 0) {
    return values.map(() => 0);
  }
  return values.map((value) => (value / max) * 100);
}

function sanitizeSeries(series: LineChartSeries[], scaleMode: LineChartProps["scaleMode"]): SanitizedLineChartSeries[] {
  return series
    .map((entry, index) => {
      const values = entry.values.map(sanitizeLineValue);
      return {
        label: entry.label,
        dataKey: `series${index}`,
        values,
        plotKey: scaleMode === "series" ? `series${index}Normalized` : `series${index}`,
        plotValues: scaleMode === "series" ? normalizeSeriesValues(values) : values,
      };
    })
    .filter((entry) => entry.values.length > 0);
}

function lineChartData(series: SanitizedLineChartSeries[]): LineChartPoint[] {
  const pointCount = series.reduce((largest, entry) => Math.max(largest, entry.values.length), 0);
  return Array.from({ length: pointCount }, (_, index) => {
    const point: LineChartPoint = { index: index + 1 };
    for (const entry of series) {
      point[entry.dataKey] = entry.values[index] ?? 0;
      point[entry.plotKey] = entry.plotValues[index] ?? 0;
    }
    return point;
  });
}

function containerStyle(width?: number | string, height?: number | string) {
  return width !== undefined || height !== undefined ? { width, height } : undefined;
}

function responsiveDimension(value: number | string | undefined): ResponsiveDimension {
  if (typeof value === "number") {
    return value;
  }

  return typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value) ? (value as `${number}%`) : "100%";
}

function finiteDimension(value: number, min: number): number | null {
  return Number.isFinite(value) && value >= min ? value : null;
}

function resolvedDimensions(
  measured: ChartDimensions,
  width?: number | string,
  height?: number | string,
): ChartDimensions {
  return {
    width: typeof width === "number" && width > 0 ? width : measured.width,
    height: typeof height === "number" && height > 0 ? height : measured.height,
  };
}

function dimensionsMatch(left: ChartDimensions, right: ChartDimensions): boolean {
  return Math.abs(left.width - right.width) < 0.5 && Math.abs(left.height - right.height) < 0.5;
}

function dimensionsFromElement(element: HTMLElement): ChartDimensions | null {
  const rect = element.getBoundingClientRect();
  const width = finiteDimension(rect.width, MIN_USABLE_CHART_WIDTH);
  const height = finiteDimension(rect.height, MIN_USABLE_CHART_HEIGHT);
  if (width === null || height === null) {
    return null;
  }
  return { width, height };
}

function useMeasuredChartDimensions() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState<ChartDimensions>(FALLBACK_CHART_DIMENSIONS);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const applyDimensions = (next: ChartDimensions | null) => {
      if (!next) {
        return;
      }
      setDimensions((current) => (dimensionsMatch(current, next) ? current : next));
    };

    applyDimensions(dimensionsFromElement(element));

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const width = finiteDimension(entry.contentRect.width, MIN_USABLE_CHART_WIDTH);
      const height = finiteDimension(entry.contentRect.height, MIN_USABLE_CHART_HEIGHT);
      applyDimensions(width === null || height === null ? null : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, dimensions };
}

/**
 * FNXC:CommandCenterCharts 2026-06-18-21:52:
 * User requested real graphical pie + line charts on every Command Center surface using a proper chart library (recharts); this shared line wrapper preserves the existing series shape while coercing zero/NaN/Infinity inputs into safe responsive, token-themed, reduced-motion-aware recharts data.
 *
 * FNXC:CommandCenterCharts 2026-06-19-05:24:
 * Recharts ResponsiveContainer renders blank when its parent has no measurable block-size. Import the shared chart CSS here so every Command Center surface using this wrapper gets the token-sized default parent height even if it does not also render a hand-rolled chart primitive.
 *
 * FNXC:CommandCenterCharts 2026-06-19-07:58:
 * FN-6723 found the Activity trend still looked broken after the height/clipping fix because mixed-unit series shared one absolute axis; normalize only callers that opt into `scaleMode="series"` so low-count agent lines stay legible without changing comparable-unit charts elsewhere.
 *
 * FNXC:CommandCenterCharts 2026-06-23-08:47:
 * Daily activity line and token/model line graphs must load even when Recharts cannot resolve a percentage `ResponsiveContainer` during the card's first layout pass. Measure the chart wrapper directly and pass concrete usable dimensions into Recharts, with a first-paint fallback that is replaced by ResizeObserver only after the observed box is large enough to draw a legible chart.
 *
 * FNXC:CommandCenterProductivity 2026-06-30-10:25:
 * Duration trend callers need the shared line chart to keep real millisecond values while labeling axes/tooltips as human durations and dates. Formatting stays opt-in so existing Command Center charts preserve their numeric legends and normalized mixed-unit behavior.
 */
export function LineChart({ series, ariaLabel, width, height, emptyLabel = "No chart data", xAxisLabels, valueFormatter, scaleMode = "shared" }: LineChartProps) {
  const theme = getCommandCenterChartTheme();
  const { ref, dimensions } = useMeasuredChartDimensions();
  const chartDimensions = resolvedDimensions(dimensions, width, height);
  const chartSeries = sanitizeSeries(series, scaleMode);
  const chartData = lineChartData(chartSeries);
  const formatXAxisLabel = (value: unknown) => {
    const index = typeof value === "number" ? value : Number(value);
    return Number.isFinite(index) ? (xAxisLabels?.[index - 1] ?? String(value)) : String(value);
  };
  const formatChartValue = (value: unknown) => {
    const numericValue = typeof value === "number" ? value : Number(value);
    return valueFormatter && Number.isFinite(numericValue) ? valueFormatter(numericValue) : String(value);
  };

  if (chartSeries.length === 0 || chartData.length === 0) {
    return (
      <div className="cc-recharts-empty" role="img" aria-label={ariaLabel} style={containerStyle(width, height)}>
        {emptyLabel}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="cc-recharts-chart"
      role="img"
      aria-label={ariaLabel}
      style={containerStyle(width, height)}
      data-scale-mode={scaleMode}
      data-responsive-width={responsiveDimension(width)}
      data-responsive-height={responsiveDimension(height)}
    >
      <RechartsLineChart width={chartDimensions.width} height={chartDimensions.height} data={chartData}>
        <CartesianGrid stroke={theme.grid} />
        <XAxis dataKey="index" stroke={theme.tick} tick={{ fill: theme.tick }} tickFormatter={xAxisLabels ? formatXAxisLabel : undefined} />
        <YAxis
          stroke={theme.tick}
          tick={{ fill: theme.tick }}
          domain={scaleMode === "series" ? [0, 100] : undefined}
          tickFormatter={scaleMode === "series" ? (value) => `${value}%` : valueFormatter}
        />
        <Tooltip
          contentStyle={{
            background: theme.tooltipBackground,
            borderColor: theme.tooltipBorder,
            color: theme.tooltipText,
          }}
          itemStyle={{ color: theme.tooltipText }}
          labelStyle={{ color: theme.tooltipText }}
          formatter={valueFormatter ? (value) => formatChartValue(value) : undefined}
          labelFormatter={xAxisLabels ? formatXAxisLabel : undefined}
        />
        <Legend wrapperStyle={{ color: theme.legendText }} />
        {chartSeries.map((entry, index) => (
          <Line
            key={entry.dataKey}
            type="monotone"
            dataKey={entry.plotKey}
            name={entry.label}
            stroke={getCommandCenterChartColor(index, theme)}
            isAnimationActive={!prefersReducedMotion()}
          />
        ))}
      </RechartsLineChart>
    </div>
  );
}
