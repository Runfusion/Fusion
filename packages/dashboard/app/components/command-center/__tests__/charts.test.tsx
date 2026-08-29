import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Bar } from "../charts/Bar";
import { StackedBar } from "../charts/StackedBar";
import { Sparkline } from "../charts/Sparkline";
import { Funnel } from "../charts/Funnel";
import { RadialGauge } from "../charts/RadialGauge";
import { LineChart } from "../charts/LineChart";
import { TokenSeriesChart } from "../charts/TokenSeriesChart";

function widthOf(el: HTMLElement): string {
  return el.style.width;
}

function heightOf(el: HTMLElement): string {
  return el.style.height;
}

const chartCssPath = resolve(__dirname, "../charts/charts.css");
const chartCss = readFileSync(chartCssPath, "utf8");
const chartPaletteTokens = [
  "--accent",
  "--todo",
  "--in-progress",
  "--in-review",
  "--triage",
  "--color-success",
  "--color-warning",
  "--color-error",
];

function expectPaletteTokenRule(selector: string, token: string): void {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(chartCss).toMatch(new RegExp(`${escapedSelector}\\s*\\{[^}]*background:\\s*var\\(${token}\\)`, "s"));
}

describe("chart primitive palette CSS", () => {
  it("cycles Bar fills through the canonical palette and wraps after eight rows", () => {
    chartPaletteTokens.forEach((token, index) => {
      const nth = index === chartPaletteTokens.length - 1 ? "8n" : `8n + ${index + 1}`;
      expectPaletteTokenRule(`.cc-bar-row:nth-child(${nth}) .cc-bar-fill`, token);
    });
  });

  it("cycles StackedBar segments and legend swatches through the canonical palette", () => {
    chartPaletteTokens.forEach((token, index) => {
      const nth = index === chartPaletteTokens.length - 1 ? "8n" : `8n + ${index + 1}`;
      expectPaletteTokenRule(`.cc-stacked-segment:nth-child(${nth}),\n.cc-stacked-legend-item:nth-child(${nth}) .cc-stacked-swatch`, token);
    });
  });

  it("cycles Sparkline and Funnel fills through the canonical palette", () => {
    chartPaletteTokens.forEach((token, index) => {
      const nth = index === chartPaletteTokens.length - 1 ? "8n" : `8n + ${index + 1}`;
      expectPaletteTokenRule(`.cc-sparkline-bar:nth-child(${nth})`, token);
      expectPaletteTokenRule(`.cc-funnel-stage:nth-child(${nth}) .cc-funnel-fill`, token);
    });
  });
});

describe("Bar", () => {
  it("renders a fill per datum and an accessible label", () => {
    render(
      <Bar
        ariaLabel="tokens by model"
        data={[
          { label: "gpt-4", value: 100 },
          { label: "sonnet", value: 50 },
        ]}
      />,
    );
    expect(screen.getByRole("list", { name: "tokens by model" })).toBeTruthy();
    expect(screen.getByLabelText("gpt-4: 100")).toBeTruthy();
    expect(screen.getByLabelText("sonnet: 50")).toBeTruthy();
  });

  it("renders the largest value at 100% and scales the rest", () => {
    render(<Bar data={[{ label: "a", value: 100 }, { label: "b", value: 25 }]} />);
    expect(widthOf(screen.getByLabelText("a: 100"))).toBe("100%");
    expect(widthOf(screen.getByLabelText("b: 25"))).toBe("25%");
  });

  it("renders a 0-width bar for a zero value, never NaN", () => {
    render(<Bar data={[{ label: "zero", value: 0 }, { label: "x", value: 10 }]} />);
    const zero = screen.getByLabelText("zero: 0");
    expect(widthOf(zero)).toBe("0%");
    expect(widthOf(zero)).not.toContain("NaN");
  });

  it("renders 0-width bars for an all-zero dataset without dividing by zero", () => {
    render(<Bar data={[{ label: "a", value: 0 }, { label: "b", value: 0 }]} />);
    expect(widthOf(screen.getByLabelText("a: 0"))).toBe("0%");
    expect(widthOf(screen.getByLabelText("b: 0"))).toBe("0%");
  });

  it("treats a non-finite value as zero width", () => {
    render(<Bar data={[{ label: "nan", value: Number.NaN }]} />);
    const el = screen.getByLabelText("nan: 0");
    expect(widthOf(el)).toBe("0%");
  });

  it("renders empty, single, and more-than-palette datasets without NaN geometry", () => {
    const { rerender } = render(<Bar ariaLabel="empty bars" data={[]} />);
    expect(screen.getByRole("list", { name: "empty bars" }).querySelectorAll(".cc-bar-fill")).toHaveLength(0);

    rerender(<Bar ariaLabel="single bar" data={[{ label: "single", value: 1 }]} />);
    expect(widthOf(screen.getByLabelText("single: 1"))).toBe("100%");

    const many = Array.from({ length: 9 }, (_, index) => ({ label: `item-${index + 1}`, value: index === 8 ? 0 : index + 1 }));
    rerender(<Bar ariaLabel="many bars" data={many} />);
    expect(screen.getByRole("list", { name: "many bars" }).querySelectorAll(".cc-bar-fill")).toHaveLength(9);
    expect(widthOf(screen.getByLabelText("item-9: 0"))).toBe("0%");
    expect(screen.getByRole("list", { name: "many bars" }).innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe("StackedBar", () => {
  it("renders proportional segments and a legend", () => {
    render(
      <StackedBar
        ariaLabel="status split"
        segments={[
          { label: "done", value: 75 },
          { label: "open", value: 25 },
        ]}
      />,
    );
    expect(screen.getByRole("img", { name: "status split" })).toBeTruthy();
    expect(widthOf(screen.getByLabelText("done: 75"))).toBe("75%");
    expect(widthOf(screen.getByLabelText("open: 25"))).toBe("25%");
  });

  it("renders 0-width slices for an all-zero set, never NaN", () => {
    render(<StackedBar segments={[{ label: "a", value: 0 }, { label: "b", value: 0 }]} />);
    expect(widthOf(screen.getByLabelText("a: 0"))).toBe("0%");
    expect(widthOf(screen.getByLabelText("b: 0"))).toBe("0%");
  });

  it("renders empty, single, and more-than-palette segment sets without NaN geometry", () => {
    const { rerender } = render(<StackedBar ariaLabel="empty stack" segments={[]} />);
    expect(screen.getByRole("img", { name: "empty stack" }).querySelectorAll(".cc-stacked-segment")).toHaveLength(0);

    rerender(<StackedBar ariaLabel="single stack" segments={[{ label: "single", value: 3 }]} />);
    expect(widthOf(screen.getByLabelText("single: 3"))).toBe("100%");

    const many = Array.from({ length: 9 }, (_, index) => ({ label: `segment-${index + 1}`, value: index === 8 ? 0 : 1 }));
    rerender(<StackedBar ariaLabel="many stack" segments={many} />);
    expect(screen.getByRole("img", { name: "many stack" }).querySelectorAll(".cc-stacked-segment")).toHaveLength(9);
    expect(widthOf(screen.getByLabelText("segment-9: 0"))).toBe("0%");
    expect(screen.getByRole("img", { name: "many stack" }).innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe("Sparkline", () => {
  it("renders one bar per value with proportional heights", () => {
    render(<Sparkline ariaLabel="models per day" values={[2, 4, 0]} />);
    const sparkline = screen.getByRole("img", { name: "models per day" });
    const bars = sparkline.querySelectorAll<HTMLElement>(".cc-sparkline-bar");
    expect(bars.length).toBe(3);
    expect(heightOf(bars[0])).toBe("50%");
    expect(heightOf(bars[1])).toBe("100%");
    expect(heightOf(bars[2])).toBe("0%");
  });

  it("renders 0-height bars for all-zero values without NaN", () => {
    render(<Sparkline ariaLabel="empty" values={[0, 0]} />);
    const bars = screen.getByRole("img", { name: "empty" }).querySelectorAll<HTMLElement>(".cc-sparkline-bar");
    expect(heightOf(bars[0])).toBe("0%");
    expect(heightOf(bars[1])).toBe("0%");
  });

  it("renders empty, single, and more-than-palette value sets without NaN geometry", () => {
    const { rerender } = render(<Sparkline ariaLabel="empty spark" values={[]} />);
    expect(screen.getByRole("img", { name: "empty spark" }).querySelectorAll(".cc-sparkline-bar")).toHaveLength(0);

    rerender(<Sparkline ariaLabel="single spark" values={[4]} />);
    expect(heightOf(screen.getByRole("img", { name: "single spark" }).querySelector<HTMLElement>(".cc-sparkline-bar")!)).toBe("100%");

    rerender(<Sparkline ariaLabel="many spark" values={[1, 2, 3, 4, 5, 6, 7, 8, 0]} />);
    const bars = screen.getByRole("img", { name: "many spark" }).querySelectorAll<HTMLElement>(".cc-sparkline-bar");
    expect(bars).toHaveLength(9);
    expect(heightOf(bars[8])).toBe("0%");
    expect(screen.getByRole("img", { name: "many spark" }).innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe("TokenSeriesChart", () => {
  it("renders proportional token buckets with an accessible label", () => {
    render(
      <TokenSeriesChart
        ariaLabel="tokens over time"
        points={[
          { bucket: "2026-06-08", inputTokens: 50, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 100, nTasks: 1, cost: { usd: null, unavailable: true, stale: false } },
          { bucket: "2026-06-09", inputTokens: 25, outputTokens: 25, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 50, nTasks: 1, cost: { usd: null, unavailable: true, stale: false } },
        ]}
      />,
    );

    const chart = screen.getByRole("img", { name: "tokens over time" });
    const bars = chart.querySelectorAll<HTMLElement>(".cc-token-series-bar");
    expect(bars).toHaveLength(2);
    expect(heightOf(bars[0])).toBe("100%");
    expect(heightOf(bars[1])).toBe("50%");
  });

  it("renders an empty zero state without NaN geometry", () => {
    render(<TokenSeriesChart ariaLabel="empty tokens" points={[]} />);

    const chart = screen.getByRole("img", { name: "empty tokens" });
    expect(screen.getByTestId("cc-token-series-empty")).toBeTruthy();
    expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("renders all-zero buckets as zero-height bars", () => {
    render(
      <TokenSeriesChart
        ariaLabel="zero tokens"
        points={[
          { bucket: "2026-06-08", inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0, cost: { usd: null, unavailable: false, stale: false } },
        ]}
      />,
    );

    const bar = screen.getByRole("img", { name: "zero tokens" }).querySelector<HTMLElement>(".cc-token-series-bar");
    expect(bar?.style.height).toBe("0%");
    expect(bar?.outerHTML).not.toMatch(/NaN|Infinity/);
  });
});

function numericAttribute(element: Element, name: string): number {
  return Number(element.getAttribute(name));
}

function expectLineChartPointsInsideViewBox(chart: Element): void {
  const [, , viewBoxWidth, viewBoxHeight] = viewBoxNumbers(chart);
  for (const point of Array.from(chart.querySelectorAll(".cc-line-chart-point"))) {
    const cx = numericAttribute(point, "cx");
    const cy = numericAttribute(point, "cy");
    const r = numericAttribute(point, "r");
    expect(cx).toBeGreaterThanOrEqual(r);
    expect(cx).toBeLessThanOrEqual(viewBoxWidth - r);
    expect(cy).toBeGreaterThanOrEqual(r);
    expect(cy).toBeLessThanOrEqual(viewBoxHeight - r);
  }
}

function viewBoxNumbers(chart: Element): [number, number, number, number] {
  return (chart.getAttribute("viewBox") ?? "")
    .split(/\s+/)
    .map(Number) as [number, number, number, number];
}

function linePointTuples(line: Element): Array<[number, number]> {
  return (line.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split(",").map(Number) as [number, number]);
}

function expectLineChartFillsBoxAndKeepsRoundMarkers(chart: Element): void {
  const [, , viewBoxWidth, viewBoxHeight] = viewBoxNumbers(chart);
  expect(viewBoxWidth).toBeGreaterThan(viewBoxHeight);
  expect(chart.getAttribute("preserveAspectRatio")).toBe("none");
  expect(chart.getAttribute("viewBox")).not.toBe("0 0 100 100");
  expect(chart.querySelectorAll(".cc-line-chart-point").length).toBeGreaterThan(0);
}

function expectLineChartPathFillsPlotWidth(chart: Element): void {
  const [, , viewBoxWidth] = viewBoxNumbers(chart);
  const line = chart.querySelector(".cc-line-chart-path");
  expect(line).toBeTruthy();
  const points = linePointTuples(line!);
  expect(points[0]?.[0]).toBe(3);
  expect(points.at(-1)?.[0]).toBe(viewBoxWidth - 3);
}

describe("LineChart", () => {
  it("renders a populated finite SVG line with an accessible label", () => {
    render(<LineChart ariaLabel="activity trend" series={[{ label: "messages", values: [2, 4, 1] }]} />);

    const chart = screen.getByRole("img", { name: "activity trend" });
    const line = chart.querySelector(".cc-line-chart-path");
    const points = line?.getAttribute("points") ?? "";

    expect(line).toBeTruthy();
    expect(points).not.toBe("");
    expect(points).not.toMatch(/NaN|Infinity/);
    expectLineChartPointsInsideViewBox(chart);
    expectLineChartFillsBoxAndKeepsRoundMarkers(chart);
    expectLineChartPathFillsPlotWidth(chart);
  });

  it("uses uniform SVG scaling so marker circles cannot stretch into ovals", () => {
    render(<LineChart ariaLabel="mobile activity trend" series={[{ label: "agents", values: [1, 3, 2] }]} />);

    const chart = screen.getByRole("img", { name: "mobile activity trend" });
    expectLineChartFillsBoxAndKeepsRoundMarkers(chart);
  });

  it("keeps mobile sizing non-square while SVG geometry remains uniformly scaled", () => {
    expect(chartCss).toMatch(/@media \(max-width: 768px\)\s*\{[^@]*\.cc-line-chart\s*\{[^}]*aspect-ratio:\s*auto;/s);

    render(<LineChart ariaLabel="narrow activity trend" series={[{ label: "nodes", values: [1, 2, 1] }]} />);

    const chart = screen.getByRole("img", { name: "narrow activity trend" });
    expectLineChartFillsBoxAndKeepsRoundMarkers(chart);
    expectLineChartPathFillsPlotWidth(chart);
  });

  it("updates the viewBox from ResizeObserver so variable mobile boxes keep round markers", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    class ImmediateResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 320, height: 160 } as DOMRectReadOnly } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ImmediateResizeObserver as unknown as typeof ResizeObserver;
    try {
      render(<LineChart ariaLabel="measured mobile activity trend" series={[{ label: "nodes", values: [1, 2, 1] }]} />);
      const chart = screen.getByRole("img", { name: "measured mobile activity trend" });
      await waitFor(() => expect(chart.getAttribute("viewBox")).toBe("0 0 320 160"));
      expectLineChartFillsBoxAndKeepsRoundMarkers(chart);
      expectLineChartPathFillsPlotWidth(chart);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("renders all-zero values as valid baseline geometry without NaN or edge clipping", () => {
    render(<LineChart ariaLabel="zero trend" series={[{ label: "zero", values: [0, 0] }]} />);

    const chart = screen.getByRole("img", { name: "zero trend" });
    const points = chart.querySelector(".cc-line-chart-path")?.getAttribute("points") ?? "";
    expect(points).not.toMatch(/NaN|Infinity/);
    expectLineChartPointsInsideViewBox(chart);
  });

  it("renders a single-point series as a visible point without a malformed line", () => {
    render(<LineChart ariaLabel="single trend" series={[{ label: "single", values: [5] }]} />);

    const chart = screen.getByRole("img", { name: "single trend" });
    expect(chart.querySelector(".cc-line-chart-path")).toBeNull();
    const point = chart.querySelector(".cc-line-chart-point");
    expect(point?.getAttribute("cx")).toBe("125");
    expect(point?.getAttribute("cy")).not.toMatch(/NaN|Infinity/);
    expectLineChartPointsInsideViewBox(chart);
  });

  it("keeps max-value endpoints inside the SVG viewBox instead of clipping them", () => {
    render(<LineChart ariaLabel="edge trend" series={[{ label: "edge", values: [0, 10] }]} />);

    const chart = screen.getByRole("img", { name: "edge trend" });
    const points = chart.querySelector(".cc-line-chart-path")?.getAttribute("points") ?? "";
    expect(points).not.toBe("0,100 100,0");
    expect(points).not.toMatch(/NaN|Infinity/);
    expectLineChartPointsInsideViewBox(chart);
  });

  it("coerces non-finite and negative values without leaking invalid SVG geometry", () => {
    render(<LineChart ariaLabel="invalid trend" series={[{ label: "invalid", values: [Number.NaN, Number.POSITIVE_INFINITY, -2, 4] }]} />);

    const chart = screen.getByRole("img", { name: "invalid trend" });
    expect(chart.outerHTML).not.toMatch(/NaN|Infinity/);
    expectLineChartPointsInsideViewBox(chart);
  });

  it("renders an empty series as an empty valid SVG without throwing", () => {
    render(<LineChart ariaLabel="empty line" series={[{ label: "empty", values: [] }]} />);

    const chart = screen.getByRole("img", { name: "empty line" });
    expect(chart.querySelector(".cc-line-chart-path")).toBeNull();
    expect(chart.querySelector(".cc-line-chart-point")).toBeNull();
  });
});

describe("RadialGauge", () => {
  it("renders the percentage for a valid ratio with an accessible label", () => {
    render(<RadialGauge value={0.73} label="Completion" ariaLabel="Completion rate" />);
    expect(screen.getByRole("img", { name: "Completion rate" })).toBeTruthy();
    expect(screen.getByText("73%")).toBeTruthy();
    expect(screen.getByText("Completion")).toBeTruthy();
  });

  it("renders an em dash for a null ratio", () => {
    render(<RadialGauge value={null} label="Completion" ariaLabel="Completion rate" />);
    expect(screen.getByRole("img", { name: "Completion rate" })).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders safe 0% text for zero and non-finite numeric input", () => {
    const { rerender } = render(<RadialGauge value={0} label="Zero" ariaLabel="Zero rate" />);
    expect(screen.getByText("0%")).toBeTruthy();
    rerender(<RadialGauge value={Number.NaN} label="NaN" ariaLabel="NaN rate" />);
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("0%").textContent).not.toContain("NaN");
  });
});

describe("Funnel", () => {
  it("renders stages with conversion from the prior stage", () => {
    render(
      <Funnel
        ariaLabel="sdlc"
        stages={[
          { label: "triage", value: 100 },
          { label: "todo", value: 50 },
          { label: "done", value: 25 },
        ]}
      />,
    );
    expect(widthOf(screen.getByLabelText("triage: 100"))).toBe("100%");
    expect(widthOf(screen.getByLabelText("todo: 50"))).toBe("50%");
    // first stage has no conversion label; subsequent stages do (todo=50%, done=50%)
    expect(screen.getAllByText("50%").length).toBe(2);
  });

  it("shows a — conversion when the prior stage is zero, never NaN%", () => {
    render(<Funnel stages={[{ label: "a", value: 0 }, { label: "b", value: 5 }]} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(widthOf(screen.getByLabelText("a: 0"))).toBe("0%");
  });

  it("renders empty, single, and more-than-palette stages without NaN geometry", () => {
    const { rerender } = render(<Funnel ariaLabel="empty funnel" stages={[]} />);
    expect(screen.getByLabelText("empty funnel").querySelectorAll(".cc-funnel-fill")).toHaveLength(0);

    rerender(<Funnel ariaLabel="single funnel" stages={[{ label: "single", value: 2 }]} />);
    expect(widthOf(screen.getByLabelText("single: 2"))).toBe("100%");

    const many = Array.from({ length: 9 }, (_, index) => ({ label: `stage-${index + 1}`, value: index === 8 ? 0 : index + 1 }));
    rerender(<Funnel ariaLabel="many funnel" stages={many} />);
    expect(screen.getByLabelText("many funnel").querySelectorAll(".cc-funnel-fill")).toHaveLength(9);
    expect(widthOf(screen.getByLabelText("stage-9: 0"))).toBe("0%");
    expect(screen.getByLabelText("many funnel").innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

/**
 * Real-browser-style guard for the IACVT token trap: the chart CSS must drive
 * its loader animation off a bare --duration-* token, never a --transition-*
 * duration+easing pair (which silently resolves to animation: none).
 */
describe("chart CSS animation tokens", () => {
  it("uses a --duration-* token in the loader animation, not --transition-*", () => {
    const animationLines = chartCss.split("\n").filter((line) => /animation\s*:/.test(line) && !/animation\s*:\s*none/.test(line));
    expect(animationLines.length).toBeGreaterThan(0);
    for (const line of animationLines) {
      expect(line).not.toMatch(/var\(--transition-/);
      expect(line).toMatch(/var\(--duration-/);
    }
  });
});
