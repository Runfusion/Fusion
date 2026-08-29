import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PieChart } from "../PieChart";
import type { PieChartProps } from "../PieChart";

const chartSize = { width: 320, height: 220 };
const fallbackChartSize = { width: 320, height: 220 };

function chartHtml(label: string): string {
  return screen.getByRole("img", { name: label }).outerHTML;
}

function renderChart(data: PieChartProps["data"], ariaLabel = "pie chart") {
  // FNXC:CommandCenterCharts 2026-06-18-22:01: jsdom's ResizeObserver mock does not report dimensions, so tests pass explicit dimensions through the wrapper to mount recharts children while production remains responsive.
  return render(<PieChart data={data} ariaLabel={ariaLabel} {...chartSize} />);
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

describe("recharts PieChart", () => {
  it("renders a populated multi-item pie with an accessible label and finite output", () => {
    expect(() => renderChart([{ label: "Done", value: 8 }, { label: "Todo", value: 4 }], "status split")).not.toThrow();

    expect(screen.getByRole("img", { name: "status split" })).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(chartHtml("status split")).not.toMatch(/NaN|Infinity/);
  });

  it("renders without explicit dimensions so dashboard cards do not blank during first layout", () => {
    // FNXC:CommandCenterCharts 2026-06-23-08:47: Token share by model renders from dashboard cards without width/height props; the wrapper must provide finite chart dimensions before ResizeObserver reports.
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
    expect(() => render(<PieChart data={[{ label: "gpt-5", value: 10 }]} ariaLabel="token share by model" />)).not.toThrow();

    const svg = renderedSvg("token share by model");
    expect(svg.getAttribute("width")).toBe(String(fallbackChartSize.width));
    expect(svg.getAttribute("height")).toBe(String(fallbackChartSize.height));
    expect(chartHtml("token share by model")).not.toMatch(/NaN|Infinity/);
    rectSpy.mockRestore();
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
