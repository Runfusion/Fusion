import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
  for (const point of Array.from(chart.querySelectorAll(".cc-line-chart-point"))) {
    const cx = numericAttribute(point, "cx");
    const cy = numericAttribute(point, "cy");
    const r = numericAttribute(point, "r");
    expect(cx).toBeGreaterThanOrEqual(r);
    expect(cx).toBeLessThanOrEqual(100 - r);
    expect(cy).toBeGreaterThanOrEqual(r);
    expect(cy).toBeLessThanOrEqual(100 - r);
  }
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
    expect(point?.getAttribute("cx")).toBe("50");
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
});

/**
 * Real-browser-style guard for the IACVT token trap: the chart CSS must drive
 * its loader animation off a bare --duration-* token, never a --transition-*
 * duration+easing pair (which silently resolves to animation: none).
 */
describe("chart CSS animation tokens", () => {
  const cssPath = resolve(__dirname, "../charts/charts.css");
  const css = readFileSync(cssPath, "utf8");

  it("uses a --duration-* token in the loader animation, not --transition-*", () => {
    const animationLines = css.split("\n").filter((line) => /animation\s*:/.test(line) && !/animation\s*:\s*none/.test(line));
    expect(animationLines.length).toBeGreaterThan(0);
    for (const line of animationLines) {
      expect(line).not.toMatch(/var\(--transition-/);
      expect(line).toMatch(/var\(--duration-/);
    }
  });
});
