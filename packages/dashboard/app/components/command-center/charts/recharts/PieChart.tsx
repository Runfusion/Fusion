import {
  Cell,
  Legend,
  Pie,
  PieChart as RechartsPieChart,
  Tooltip,
} from "recharts";
import { useLayoutEffect, useRef, useState } from "react";
import { getCommandCenterChartColor, getCommandCenterChartTheme } from "./theme";
import "../charts.css";

export interface PieChartDatum {
  label: string;
  value: number;
}

export interface PieChartProps {
  data: PieChartDatum[];
  ariaLabel: string;
  width?: number | string;
  height?: number | string;
  emptyLabel?: string;
}

interface SanitizedPieChartDatum {
  label: string;
  value: number;
}

type ResponsiveDimension = number | `${number}%`;
type ChartDimensions = { width: number; height: number };

const FALLBACK_CHART_DIMENSIONS: ChartDimensions = { width: 320, height: 220 };
const MIN_USABLE_CHART_WIDTH = 120;
const MIN_USABLE_CHART_HEIGHT = 120;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function sanitizePieData(data: PieChartDatum[]): SanitizedPieChartDatum[] {
  return data
    .map((entry) => ({
      label: entry.label,
      value: Number.isFinite(entry.value) && entry.value > 0 ? entry.value : 0,
    }))
    .filter((entry) => entry.value > 0);
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
 * FNXC:CommandCenterCharts 2026-06-18-21:47:
 * User requested real graphical pie + line charts on every Command Center surface using a proper chart library (recharts); this shared pie wrapper is token-themed, responsive, reduced-motion aware, and filters zero/NaN/negative values before recharts can receive invalid geometry.
 *
 * FNXC:CommandCenterCharts 2026-06-19-05:24:
 * Recharts ResponsiveContainer requires a measurable parent height. Import the shared chart CSS here so pie charts keep the same non-zero token-sized wrapper and empty fallback on Activity, Team, Overview, and other Command Center surfaces.
 *
 * FNXC:CommandCenterCharts 2026-06-23-08:47:
 * Token share by model and the other Command Center pie graphs must not depend on Recharts resolving percentage container dimensions during lazy card layout. Measure the wrapper ourselves and provide concrete usable chart dimensions, falling back until the observed box is large enough to draw a legible chart.
 */
export function PieChart({ data, ariaLabel, width, height, emptyLabel = "No chart data" }: PieChartProps) {
  const theme = getCommandCenterChartTheme();
  const { ref, dimensions } = useMeasuredChartDimensions();
  const chartDimensions = resolvedDimensions(dimensions, width, height);
  const chartData = sanitizePieData(data);

  if (chartData.length === 0) {
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
      data-responsive-width={responsiveDimension(width)}
      data-responsive-height={responsiveDimension(height)}
    >
      <RechartsPieChart width={chartDimensions.width} height={chartDimensions.height}>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="label"
          isAnimationActive={!prefersReducedMotion()}
        >
          {chartData.map((entry, index) => (
            <Cell key={entry.label} fill={getCommandCenterChartColor(index, theme)} stroke={theme.tooltipBorder} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: theme.tooltipBackground,
            borderColor: theme.tooltipBorder,
            color: theme.tooltipText,
          }}
          itemStyle={{ color: theme.tooltipText }}
          labelStyle={{ color: theme.tooltipText }}
        />
        <Legend wrapperStyle={{ color: theme.legendText }} />
      </RechartsPieChart>
    </div>
  );
}
