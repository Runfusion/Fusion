import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LineChart } from "../LineChart";
import type { LineChartSeries } from "../LineChart";

const chartSize = { width: 360, height: 220 };
const fallbackChartSize = { width: 360, height: 220 };

function chartHtml(label: string): string {
  return screen.getByRole("img", { name: label }).outerHTML;
}

function renderChart(series: LineChartSeries[], ariaLabel = "line chart", scaleMode?: "shared" | "series") {
  // FNXC:CommandCenterCharts 2026-06-18-22:03: jsdom's ResizeObserver mock does not report dimensions, so tests pass explicit dimensions through the wrapper to mount recharts children while production remains responsive.
  return render(<LineChart series={series} ariaLabel={ariaLabel} {...chartSize} scaleMode={scaleMode} />);
}

function ySpanForDots(seriesName: string): number {
  const values = Array.from(document.querySelectorAll<SVGCircleElement>(`.recharts-line-dot[name="${seriesName}"]`)).map((dot) => Number(dot.getAttribute("cy")));
  expect(values.length).toBeGreaterThan(1);
  return Math.max(...values) - Math.min(...values);
}

function renderedSvg(label: string): SVGSVGElement {
  const svgs = Array.from(screen.getByRole("img", { name: label }).querySelectorAll<SVGSVGElement>("svg.recharts-surface"));
  const svg = svgs.sort((left, right) => Number(right.getAttribute("width")) - Number(left.getAttribute("width")))[0];
  expect(svg).toBeTruthy();
  return svg;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recharts LineChart", () => {
  it("renders populated multi-series lines with an accessible label and finite output", () => {
    expect(() => renderChart([
      { label: "Messages", values: [1, 3, 2] },
      { label: "Tasks", values: [0, 2, 4] },
    ], "activity trend")).not.toThrow();

    expect(screen.getByRole("img", { name: "activity trend" })).toBeTruthy();
    expect(screen.getByText("Messages")).toBeTruthy();
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(chartHtml("activity trend")).not.toMatch(/NaN|Infinity/);
  });

  it("renders without explicit dimensions so dashboard cards do not blank during first layout", () => {
    // FNXC:CommandCenterCharts 2026-06-23-08:47: Daily activity line renders from dashboard cards without passing width/height props; first paint needs finite SVG dimensions before browser measurement settles.
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect);
    expect(() => render(<LineChart series={[{ label: "Messages", values: [1, 3, 2] }]} ariaLabel="daily activity line" />)).not.toThrow();

    const svg = renderedSvg("daily activity line");
    expect(svg.getAttribute("width")).toBe(String(fallbackChartSize.width));
    expect(svg.getAttribute("height")).toBe(String(fallbackChartSize.height));
    expect(chartHtml("daily activity line")).not.toMatch(/NaN|Infinity/);
    rectSpy.mockRestore();
  });

  it("renders a single-point series cleanly", () => {
    expect(() => renderChart([{ label: "Single", values: [5] }], "single point")).not.toThrow();

    expect(screen.getByRole("img", { name: "single point" })).toBeTruthy();
    expect(screen.getByText("Single")).toBeTruthy();
    expect(chartHtml("single point")).not.toMatch(/NaN|Infinity/);
  });

  it("renders an accessible empty state for empty input", () => {
    expect(() => renderChart([], "empty line")).not.toThrow();

    expect(screen.getByRole("img", { name: "empty line" })).toBeTruthy();
    expect(screen.getByText("No chart data")).toBeTruthy();
    expect(chartHtml("empty line")).not.toMatch(/NaN|Infinity/);
  });

  it("renders all-zero series as a valid baseline chart", () => {
    expect(() => renderChart([{ label: "Zero", values: [0, 0, 0] }], "zero line")).not.toThrow();

    expect(screen.getByRole("img", { name: "zero line" })).toBeTruthy();
    expect(screen.getByText("Zero")).toBeTruthy();
    expect(screen.queryByText("No chart data")).toBeNull();
    expect(chartHtml("zero line")).not.toMatch(/NaN|Infinity/);
  });

  it("normalizes mixed-unit series so low-count activity lines are not flattened", () => {
    renderChart([
      { label: "Messages", values: [1_000, 1_200, 1_100] },
      { label: "Active agents", values: [1, 2, 1] },
      { label: "Agent runs", values: [2, 4, 3] },
    ], "activity trend", "series");

    const chart = screen.getByRole("img", { name: "activity trend" });
    expect(chart).toHaveAttribute("data-scale-mode", "series");
    expect(ySpanForDots("Active agents")).toBeGreaterThan(40);
    expect(ySpanForDots("Agent runs")).toBeGreaterThan(40);
    expect(chartHtml("activity trend")).not.toMatch(/NaN|Infinity/);
  });

  it("keeps shared absolute scale as the default for comparable series", () => {
    renderChart([
      { label: "Filed", values: [3, 6, 9] },
      { label: "Fixed", values: [2, 4, 8] },
    ], "issue flow");

    expect(screen.getByRole("img", { name: "issue flow" })).toHaveAttribute("data-scale-mode", "shared");
    expect(chartHtml("issue flow")).not.toContain("% of series");
  });

  it("coerces non-finite and negative values without leaking invalid output", () => {
    expect(() => renderChart([{ label: "Invalid", values: [Number.NaN, Number.POSITIVE_INFINITY, -4, 2] }], "invalid line")).not.toThrow();

    expect(screen.getByRole("img", { name: "invalid line" })).toBeTruthy();
    expect(screen.getByText("Invalid")).toBeTruthy();
    expect(chartHtml("invalid line")).not.toMatch(/NaN|Infinity/);
  });

  it("checks reduced-motion preference before enabling recharts animation", () => {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    renderChart([{ label: "Messages", values: [1, 2] }], "reduced motion line");

    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(chartHtml("reduced motion line")).not.toMatch(/NaN|Infinity/);
  });
});
