import {
  Cell,
  Legend,
  Pie,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
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

/**
 * FNXC:CommandCenterCharts 2026-06-18-21:47:
 * User requested real graphical pie + line charts on every Command Center surface using a proper chart library (recharts); this shared pie wrapper is token-themed, responsive, reduced-motion aware, and filters zero/NaN/negative values before recharts can receive invalid geometry.
 *
 * FNXC:CommandCenterCharts 2026-06-19-05:24:
 * Recharts ResponsiveContainer requires a measurable parent height. Import the shared chart CSS here so pie charts keep the same non-zero token-sized wrapper and empty fallback on Activity, Team, Overview, and other Command Center surfaces.
 */
export function PieChart({ data, ariaLabel, width, height, emptyLabel = "No chart data" }: PieChartProps) {
  const theme = getCommandCenterChartTheme();
  const chartData = sanitizePieData(data);

  if (chartData.length === 0) {
    return (
      <div className="cc-recharts-empty" role="img" aria-label={ariaLabel} style={containerStyle(width, height)}>
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="cc-recharts-chart" role="img" aria-label={ariaLabel} style={containerStyle(width, height)}>
      <ResponsiveContainer width={responsiveDimension(width)} height={responsiveDimension(height)}>
        <RechartsPieChart>
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
      </ResponsiveContainer>
    </div>
  );
}
