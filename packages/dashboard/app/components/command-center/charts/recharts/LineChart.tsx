import {
  CartesianGrid,
  Legend,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
}

interface SanitizedLineChartSeries {
  label: string;
  dataKey: string;
  values: number[];
}

type LineChartPoint = { index: number } & Record<string, number>;
type ResponsiveDimension = number | `${number}%`;

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

function sanitizeSeries(series: LineChartSeries[]): SanitizedLineChartSeries[] {
  return series
    .map((entry, index) => ({
      label: entry.label,
      dataKey: `series${index}`,
      values: entry.values.map(sanitizeLineValue),
    }))
    .filter((entry) => entry.values.length > 0);
}

function lineChartData(series: SanitizedLineChartSeries[]): LineChartPoint[] {
  const pointCount = series.reduce((largest, entry) => Math.max(largest, entry.values.length), 0);
  return Array.from({ length: pointCount }, (_, index) => {
    const point: LineChartPoint = { index: index + 1 };
    for (const entry of series) {
      point[entry.dataKey] = entry.values[index] ?? 0;
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

/**
 * FNXC:CommandCenterCharts 2026-06-18-21:52:
 * User requested real graphical pie + line charts on every Command Center surface using a proper chart library (recharts); this shared line wrapper preserves the existing series shape while coercing zero/NaN/Infinity inputs into safe responsive, token-themed, reduced-motion-aware recharts data.
 *
 * FNXC:CommandCenterCharts 2026-06-19-05:24:
 * Recharts ResponsiveContainer renders blank when its parent has no measurable block-size. Import the shared chart CSS here so every Command Center surface using this wrapper gets the token-sized default parent height even if it does not also render a hand-rolled chart primitive.
 */
export function LineChart({ series, ariaLabel, width, height, emptyLabel = "No chart data" }: LineChartProps) {
  const theme = getCommandCenterChartTheme();
  const chartSeries = sanitizeSeries(series);
  const chartData = lineChartData(chartSeries);

  if (chartSeries.length === 0 || chartData.length === 0) {
    return (
      <div className="cc-recharts-empty" role="img" aria-label={ariaLabel} style={containerStyle(width, height)}>
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="cc-recharts-chart" role="img" aria-label={ariaLabel} style={containerStyle(width, height)}>
      <ResponsiveContainer width={responsiveDimension(width)} height={responsiveDimension(height)}>
        <RechartsLineChart data={chartData}>
          <CartesianGrid stroke={theme.grid} />
          <XAxis dataKey="index" stroke={theme.tick} tick={{ fill: theme.tick }} />
          <YAxis stroke={theme.tick} tick={{ fill: theme.tick }} />
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
          {chartSeries.map((entry, index) => (
            <Line
              key={entry.dataKey}
              type="monotone"
              dataKey={entry.dataKey}
              name={entry.label}
              stroke={getCommandCenterChartColor(index, theme)}
              isAnimationActive={!prefersReducedMotion()}
            />
          ))}
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  );
}
