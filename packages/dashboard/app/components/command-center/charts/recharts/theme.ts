export interface CommandCenterChartTheme {
  stroke: string;
  fill: string;
  grid: string;
  tick: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
  legendText: string;
  palette: string[];
}

const TOKEN_FALLBACK = "currentColor";

const paletteTokens = [
  "--accent",
  "--todo",
  "--in-progress",
  "--in-review",
  "--triage",
  "--color-success",
  "--color-warning",
  "--color-error",
] as const;

function cssTokenValue(tokenName: string, fallback = TOKEN_FALLBACK): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return fallback;
  }

  const value = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
  return value.length > 0 ? value : fallback;
}

function cssTokenValueOptional(tokenName: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return "";
  }

  return getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
}

/**
 * FNXC:CommandCenterCharts 2026-06-18-21:41:
 * User requested real graphical pie + line charts on every Command Center surface using recharts; resolve dashboard CSS tokens at render time so wrappers stay theme-aware while keeping SSR/jsdom fallbacks free of undefined, NaN, or hardcoded color output.
 */
export function getCommandCenterChartTheme(): CommandCenterChartTheme {
  const text = cssTokenValue("--text");
  const mutedText = cssTokenValue("--text-muted", text);
  const accent = cssTokenValue("--accent");
  const surface = cssTokenValue("--surface-1", "");
  const surfaceAlt = cssTokenValue("--surface-2", surface);
  const border = cssTokenValue("--border-subtle", "");
  const palette = paletteTokens.map((tokenName) => cssTokenValue(tokenName)).filter((value) => value.length > 0);

  return {
    stroke: accent,
    fill: surfaceAlt,
    grid: border,
    tick: mutedText,
    tooltipBackground: surface,
    tooltipBorder: border,
    tooltipText: text,
    legendText: mutedText,
    palette: palette.length > 0 ? palette : [TOKEN_FALLBACK],
  };
}

export function getCommandCenterChartColor(index: number, theme = getCommandCenterChartTheme()): string {
  if (theme.palette.length === 0) {
    return TOKEN_FALLBACK;
  }

  const safeIndex = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  return theme.palette[safeIndex % theme.palette.length] ?? TOKEN_FALLBACK;
}

export function getCommandCenterChartCssToken(tokenName: string, fallback = TOKEN_FALLBACK): string {
  return cssTokenValue(tokenName, fallback);
}

export function getCommandCenterChartOptionalCssToken(tokenName: string): string {
  return cssTokenValueOptional(tokenName);
}
