import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LineChart } from "../LineChart";
import type { LineChartSeries } from "../LineChart";

const chartSize = { width: 360, height: 220 };

function chartHtml(label: string): string {
  return screen.getByRole("img", { name: label }).outerHTML;
}

function renderChart(series: LineChartSeries[], ariaLabel = "line chart") {
  // FNXC:CommandCenterCharts 2026-06-18-22:03: jsdom's ResizeObserver mock does not report dimensions, so tests pass explicit dimensions through the wrapper to mount recharts children while production remains responsive.
  return render(<LineChart series={series} ariaLabel={ariaLabel} {...chartSize} />);
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
