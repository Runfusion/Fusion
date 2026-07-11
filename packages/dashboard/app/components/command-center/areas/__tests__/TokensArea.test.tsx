import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { costFor } from "@fusion/core";
import { TokensArea } from "../TokensArea";
import type { DateRange } from "../../DateRangePicker";

const apiMock = vi.fn();

vi.mock("../../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
}));

vi.mock("../../../ProviderIcon", () => ({
  ProviderIcon: ({ provider, size }: { provider: string; size?: "sm" | "md" | "lg" }) => (
    <span className="provider-icon" data-provider={provider.toLowerCase()} data-size={size} data-testid={`provider-icon-${provider}`} />
  ),
}));

const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };
const range30d: DateRange = { from: "2026-06-02", to: null, preset: "30d" };

function makeTokenGroup(key: string | null, totalTokens: number) {
  const inputTokens = Math.round(totalTokens * 0.6);
  const outputTokens = Math.round(totalTokens * 0.3);
  const cachedTokens = totalTokens - inputTokens - outputTokens;
  return {
    key,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens: 0,
    totalTokens,
    nTasks: 1,
    cost: { usd: key === null ? null : totalTokens / 1_000, unavailable: key === null, stale: false },
  };
}

function tokenFixture() {
  return {
    from: "2026-06-08",
    to: null,
    groupBy: "model",
    totals: {
      inputTokens: 1_350,
      outputTokens: 675,
      cachedTokens: 225,
      cacheWriteTokens: 0,
      totalTokens: 2_250,
      nTasks: 5,
    },
    cost: { usd: 12.5, unavailable: false, stale: false },
    series: [],
    groups: [
      {
        key: "claude-sonnet-4-5",
        inputTokens: 600,
        outputTokens: 300,
        cachedTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 1_000,
        nTasks: 2,
        cost: { usd: 3.5, unavailable: false, stale: false },
      },
      {
        key: "gpt-4o-mini",
        inputTokens: 500,
        outputTokens: 250,
        cachedTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 850,
        nTasks: 2,
        cost: { usd: 7, unavailable: false, stale: false },
      },
      {
        key: null,
        inputTokens: 250,
        outputTokens: 125,
        cachedTokens: 25,
        cacheWriteTokens: 0,
        totalTokens: 400,
        nTasks: 1,
        cost: { usd: null, unavailable: true, stale: false },
      },
    ],
  };
}

function glmMixedProviderTokenFixture() {
  const groups = [
    makeTokenGroup("glm-5.1", 2_400),
    makeTokenGroup("glm-4.5-air", 2_200),
    makeTokenGroup("glm-5v-turbo", 2_000),
    makeTokenGroup("gpt-4o-mini", 1_800),
    makeTokenGroup("claude-sonnet-4-5", 1_600),
    makeTokenGroup("custom-model-v1", 1_400),
    makeTokenGroup(null, 1_200),
  ];
  const totals = groups.reduce(
    (acc, group) => ({
      inputTokens: acc.inputTokens + group.inputTokens,
      outputTokens: acc.outputTokens + group.outputTokens,
      cachedTokens: acc.cachedTokens + group.cachedTokens,
      cacheWriteTokens: acc.cacheWriteTokens + group.cacheWriteTokens,
      totalTokens: acc.totalTokens + group.totalTokens,
      nTasks: acc.nTasks + group.nTasks,
    }),
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
  );

  return {
    ...tokenFixture(),
    totals,
    cost: { usd: null, unavailable: true, stale: false },
    groups,
  };
}

function last30DaysMultiModelFixture() {
  return {
    from: "2026-06-02T00:00:00.000Z",
    to: "2026-07-02T00:00:00.000Z",
    groupBy: "model",
    totals: {
      inputTokens: 950,
      outputTokens: 450,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_400,
      nTasks: 1,
    },
    cost: { usd: 4.2, unavailable: false, stale: false },
    series: [
      { bucket: "2026-06-15", inputTokens: 700, outputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000, nTasks: 1, cost: { usd: 3, unavailable: false, stale: false } },
      { bucket: "2026-06-20", inputTokens: 250, outputTokens: 150, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 400, nTasks: 1, cost: { usd: 1.2, unavailable: false, stale: false } },
    ],
    groups: [
      { key: "claude-sonnet-4-5", inputTokens: 700, outputTokens: 300, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000, nTasks: 1, cost: { usd: 3, unavailable: false, stale: false } },
      { key: "gpt-5", inputTokens: 250, outputTokens: 150, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 400, nTasks: 1, cost: { usd: 1.2, unavailable: false, stale: false } },
    ],
  };
}

function manyModelTokenFixture() {
  const groups = [
    makeTokenGroup("claude-sonnet-4-5", 2_000),
    makeTokenGroup("gpt-4o-mini", 1_900),
    ...Array.from({ length: 13 }, (_, index) => makeTokenGroup(`model-${String(index + 1).padStart(2, "0")}`, 1_800 - index * 100)),
    makeTokenGroup(null, 150),
    makeTokenGroup("(unknown)", 125),
  ];
  const totals = groups.reduce(
    (acc, group) => ({
      inputTokens: acc.inputTokens + group.inputTokens,
      outputTokens: acc.outputTokens + group.outputTokens,
      cachedTokens: acc.cachedTokens + group.cachedTokens,
      cacheWriteTokens: acc.cacheWriteTokens + group.cacheWriteTokens,
      totalTokens: acc.totalTokens + group.totalTokens,
      nTasks: acc.nTasks + group.nTasks,
    }),
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
  );

  return {
    ...tokenFixture(),
    totals,
    cost: { usd: null, unavailable: true, stale: false },
    groups,
  };
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue(tokenFixture());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TokensArea provider model icons", () => {
  it("renders a priced subtotal when the aggregate also contains unpriced usage", async () => {
    apiMock.mockResolvedValue({
      ...tokenFixture(),
      cost: { usd: 11.25, unavailable: true, stale: false },
      groups: [
        {
          ...tokenFixture().groups[0],
          cost: { usd: 3.5, unavailable: true, stale: false },
        },
      ],
    });

    render(<TokensArea range={range7d} />);

    expect(await screen.findByTestId("cc-tokens-cost")).toHaveTextContent("$11.25+");
    expect(screen.getByTestId("cc-tokens-row-claude-sonnet-4-5")).toHaveTextContent("$3.50+");
  });

  it("renders current OpenAI Codex priced costs as dollars instead of the unavailable sentinel", async () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 200_000, cachedTokens: 500_000, cacheWriteTokens: 100_000 };
    const cost = costFor(usage, { provider: "openai-codex", model: "gpt-5.5" });
    expect(cost).toEqual({ usd: 11.25, unavailable: false, stale: false });

    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      groupBy: "model",
      totals: { ...usage, totalTokens: 1_800_000, nTasks: 1 },
      cost,
      series: [{ bucket: "2026-06-18", ...usage, totalTokens: 1_800_000, nTasks: 1, cost }],
      groups: [{ key: "gpt-5.5", ...usage, totalTokens: 1_800_000, nTasks: 1, cost }],
    });
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-tokens-cost")).toHaveTextContent("$11.25");
    expect(screen.getByTestId("cc-tokens-cost")).not.toHaveTextContent("—");
    expect(screen.getByTestId("cc-tokens-row-gpt-5.5")).toHaveTextContent("$11.25");
  });

  it("renders inferred provider icons in the per-model table and Tokens by model bars", async () => {
    render(<TokensArea range={range7d} />);

    const table = await screen.findByTestId("cc-tokens-table");
    const claudeRow = screen.getByTestId("cc-tokens-row-claude-sonnet-4-5");
    const gptRow = screen.getByTestId("cc-tokens-row-gpt-4o-mini");
    const unknownRow = screen.getByTestId("cc-tokens-row-unknown");

    expect(within(claudeRow).getByText("claude-sonnet-4-5")).toBeTruthy();
    expect(within(claudeRow).getByTestId("provider-icon-anthropic")).toBeTruthy();
    expect(within(gptRow).getByText("gpt-4o-mini")).toBeTruthy();
    expect(within(gptRow).getByTestId("provider-icon-openai")).toBeTruthy();
    expect(within(unknownRow).getByText("(unknown)")).toBeTruthy();
    expect(within(unknownRow).getByTestId("provider-icon-")).toBeTruthy();

    const byModelChart = screen.getByRole("list", { name: "Tokens by model" });
    const claudeBarLabel = within(byModelChart).getByText("claude-sonnet-4-5").closest(".cc-bar-label");
    const gptBarLabel = within(byModelChart).getByText("gpt-4o-mini").closest(".cc-bar-label");
    const unknownBarLabel = within(byModelChart).getByText("(unknown)").closest(".cc-bar-label");

    expect(claudeBarLabel?.firstElementChild).toHaveAttribute("data-testid", "provider-icon-anthropic");
    expect(gptBarLabel?.firstElementChild).toHaveAttribute("data-testid", "provider-icon-openai");
    expect(unknownBarLabel?.firstElementChild).toHaveAttribute("data-testid", "provider-icon-");
    expect(table.querySelectorAll(".provider-icon").length).toBeGreaterThanOrEqual(3);

    // FNXC:TokenAnalytics 2026-06-26-14:05: The Command Center must render every model bucket returned by analytics across bars, pies, and table rows; missing Claude labels recreate the production one-model breakdown.
    expect(screen.getByTestId("cc-tokens-pie")).toHaveTextContent("claude-sonnet-4-5");
    expect(screen.getByTestId("cc-tokens-pie")).toHaveTextContent("gpt-4o-mini");
    expect(screen.getByTestId("cc-tokens-pie")).toHaveTextContent("(unknown)");
  });

  it("renders standalone GLM model rows with Z.ai icons across bars and table", async () => {
    apiMock.mockResolvedValue(glmMixedProviderTokenFixture());
    render(<TokensArea range={range7d} />);

    const table = await screen.findByTestId("cc-tokens-table");
    const byModelChart = screen.getByRole("list", { name: "Tokens by model" });

    for (const label of ["glm-5.1", "glm-4.5-air", "glm-5v-turbo"]) {
      const row = screen.getByTestId(`cc-tokens-row-${label}`);
      expect(within(row).getByText(label)).toBeTruthy();
      expect(within(row).getByTestId("provider-icon-zai")).toHaveAttribute("data-provider", "zai");
      const barLabel = within(byModelChart).getByText(label).closest(".cc-bar-label");
      expect(barLabel?.firstElementChild).toHaveAttribute("data-testid", "provider-icon-zai");
      expect(barLabel?.firstElementChild).toHaveAttribute("data-provider", "zai");
    }

    expect(within(screen.getByTestId("cc-tokens-row-gpt-4o-mini")).getByTestId("provider-icon-openai")).toBeTruthy();
    expect(within(screen.getByTestId("cc-tokens-row-claude-sonnet-4-5")).getByTestId("provider-icon-anthropic")).toBeTruthy();
    expect(within(screen.getByTestId("cc-tokens-row-custom-model-v1")).getByTestId("provider-icon-custom-model-v1")).toBeTruthy();
    expect(within(screen.getByTestId("cc-tokens-row-unknown")).getByTestId("provider-icon-")).toBeTruthy();
    expect(table.querySelectorAll('.provider-icon[data-provider="zai"]').length).toBe(3);
  });

  it("renders Last 30 days multi-model groups across bar, pie, line, and table surfaces", async () => {
    apiMock.mockResolvedValue(last30DaysMultiModelFixture());
    render(<TokensArea range={range30d} />);

    const byModelChart = await screen.findByRole("list", { name: "Tokens by model" });
    const pie = screen.getByTestId("cc-tokens-pie");
    const table = screen.getByTestId("cc-tokens-table");
    const line = screen.getByTestId("cc-tokens-line");

    expect(apiMock).toHaveBeenCalledWith(
      "/command-center/tokens?groupBy=model&granularity=day&from=2026-06-02",
      undefined,
    );
    for (const label of ["claude-sonnet-4-5", "gpt-5"]) {
      expect(within(byModelChart).getAllByText(label).length).toBeGreaterThan(0);
      expect(within(pie).getAllByText(label).length).toBeGreaterThan(0);
      expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(table).getByTestId("cc-tokens-row-claude-sonnet-4-5")).toHaveTextContent("1,000");
    expect(within(table).getByTestId("cc-tokens-row-gpt-5")).toHaveTextContent("400");
    expect(line).toHaveTextContent("Total");
    expect(screen.getByTestId("cc-tokens-total")).toHaveTextContent("1,400");
  });

  it("renders every analytics model group in detail bar, pie, and table even beyond the old cap", async () => {
    apiMock.mockResolvedValue(manyModelTokenFixture());
    render(<TokensArea range={range7d} />);

    const byModelChart = await screen.findByRole("list", { name: "Tokens by model" });
    const pie = screen.getByTestId("cc-tokens-pie");
    const table = screen.getByTestId("cc-tokens-table");
    const expectedLabels = [
      "claude-sonnet-4-5",
      "gpt-4o-mini",
      ...Array.from({ length: 13 }, (_, index) => `model-${String(index + 1).padStart(2, "0")}`),
      "(unknown)",
    ];

    // FNXC:CommandCenter 2026-06-27-09:55: Symptom verification for FN-7117 uses more than the former 12-row detail cap plus null/literal unknown labels, so any reintroduced bar/pie truncation drops model-13 or one of the unknown buckets here.
    for (const label of expectedLabels) {
      expect(within(byModelChart).getAllByText(label).length).toBeGreaterThan(0);
      expect(within(pie).getAllByText(label).length).toBeGreaterThan(0);
      expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByTestId("cc-tokens-row-unknown")).toHaveTextContent("(unknown)");
    expect(screen.getByTestId("cc-tokens-row-(unknown)")).toHaveTextContent("(unknown)");
  });
});

describe("FUX-037: TokensArea projectId scoping", () => {
  it("appends projectId to the tokens request when supplied, and omits it when not", async () => {
    render(<TokensArea range={range7d} projectId="proj-tokens" />);
    await screen.findByTestId("cc-tokens-table");
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe(
      "/command-center/tokens?groupBy=model&granularity=day&from=2026-06-08&projectId=proj-tokens",
    );
  });
});
