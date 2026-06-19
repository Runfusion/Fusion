import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PieChart } from "../PieChart";
import type { PieChartProps } from "../PieChart";

const chartSize = { width: 320, height: 220 };

function chartHtml(label: string): string {
  return screen.getByRole("img", { name: label }).outerHTML;
}

function renderChart(data: PieChartProps["data"], ariaLabel = "pie chart") {
  // FNXC:CommandCenterCharts 2026-06-18-22:01: jsdom's ResizeObserver mock does not report dimensions, so tests pass explicit dimensions through the wrapper to mount recharts children while production remains responsive.
  return render(<PieChart data={data} ariaLabel={ariaLabel} {...chartSize} />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recharts PieChart", () => {
  it("renders a populated multi-item pie with an accessible label and finite output", () => {
    expect(() => renderChart([{ label: "Done", value: 8 }, { label: "Todo", value: 4 }], "status split")).not.toThrow();

    expect(screen.getByRole("img", { name: "status split" })).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(chartHtml("status split")).not.toMatch(/NaN|Infinity/);
  });

  it("renders a single-item pie without invalid geometry", () => {
    expect(() => renderChart([{ label: "Only", value: 3 }], "single slice")).not.toThrow();

    expect(screen.getByRole("img", { name: "single slice" })).toBeTruthy();
    expect(screen.getByText("Only")).toBeTruthy();
    expect(chartHtml("single slice")).not.toMatch(/NaN|Infinity/);
  });

  it("renders an accessible empty state for empty input", () => {
    expect(() => renderChart([], "empty pie")).not.toThrow();

    expect(screen.getByRole("img", { name: "empty pie" })).toBeTruthy();
    expect(screen.getByText("No chart data")).toBeTruthy();
    expect(chartHtml("empty pie")).not.toMatch(/NaN|Infinity/);
  });

  it("renders an accessible empty state for all-zero input", () => {
    expect(() => renderChart([{ label: "Zero", value: 0 }], "zero pie")).not.toThrow();

    expect(screen.getByRole("img", { name: "zero pie" })).toBeTruthy();
    expect(screen.getByText("No chart data")).toBeTruthy();
    expect(chartHtml("zero pie")).not.toMatch(/NaN|Infinity/);
  });

  it("filters non-finite and negative values without leaking invalid output", () => {
    expect(() => renderChart([
      { label: "NaN", value: Number.NaN },
      { label: "Infinity", value: Number.POSITIVE_INFINITY },
      { label: "Negative", value: -2 },
    ], "invalid pie")).not.toThrow();

    expect(screen.getByRole("img", { name: "invalid pie" })).toBeTruthy();
    expect(screen.getByText("No chart data")).toBeTruthy();
    expect(chartHtml("invalid pie")).not.toMatch(/NaN|Infinity/);
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

    renderChart([{ label: "Done", value: 1 }], "reduced motion pie");

    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(chartHtml("reduced motion pie")).not.toMatch(/NaN|Infinity/);
  });
});
