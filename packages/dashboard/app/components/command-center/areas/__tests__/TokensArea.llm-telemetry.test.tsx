import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TokensArea } from "../TokensArea";
import type { DateRange } from "../../DateRangePicker";

/*
FNXC:LaneTelemetry 2026-11-04-05:09 (R1/R5/R6):
The Tokens area now carries a second, differently-scoped payload: what each lane SENT over a short
window, from `usage_events`, beside the board-spend totals it already showed. What these cases pin is
the part a server test cannot: that an unmeasured cache share renders as "unmeasured" (a 0% here would
send an operator hunting a cache bug that does not exist), that lanes and models come from the payload
rather than a fixed set, and that the section's window toggle is the axis it actually fetches on.
*/

const apiMock = vi.fn();

vi.mock("../../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({
    tokenEstimate: 0,
    sourceFileCount: 0,
    sourceByteCount: 0,
    diskBytes: 0,
    diskFileCount: 0,
    method: "local",
    truncated: false,
  }),
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
}));

vi.mock("../../../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string; size?: string }) => (
    <span data-testid={`provider-icon-${provider}`} />
  ),
}));

const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };

function tokenFixture() {
  return {
    from: "2026-06-08",
    to: null,
    groupBy: "model",
    totals: { inputTokens: 600, outputTokens: 300, cachedTokens: 100, cacheWriteTokens: 0, totalTokens: 1_000, nTasks: 2 },
    cost: { usd: 3.5, unavailable: false, stale: false },
    series: [],
    groups: [
      { key: "claude-opus-4-1", inputTokens: 600, outputTokens: 300, cachedTokens: 100, cacheWriteTokens: 0, totalTokens: 1_000, nTasks: 2, cost: { usd: 3.5, unavailable: false, stale: false } },
    ],
  };
}

function laneAggregate(opts: {
  lane: string;
  requests: number;
  promptTokens: number;
  cached: number;
  reported: boolean;
  distinctHeads: number;
  diverged: number;
}) {
  const input = opts.promptTokens - opts.cached;
  return {
    lane: opts.lane,
    tokens: {
      lane: opts.lane,
      requestCount: opts.requests,
      inputTokens: input,
      outputTokens: 100,
      cachedTokens: opts.cached,
      cacheWriteTokens: 0,
      totalTokens: opts.promptTokens + 100,
      promptTokens: opts.promptTokens,
      cacheReadReported: opts.reported,
    },
    cacheReadShare: opts.reported && opts.promptTokens > 0 ? opts.cached / opts.promptTokens : null,
    head: {
      lane: opts.lane,
      headEventCount: opts.requests,
      distinctHeadHashCount: opts.distinctHeads,
      medianHeadBytes: 4_096,
      divergenceCounts: { baseline: 1, identical: opts.requests - opts.diverged - 1, diverged: opts.diverged },
      offsetBucketCounts: { lt128: 0, lt1k: 0, lt8k: opts.diverged, lt64k: 0, gte64k: 0 },
      offsetUnknownCount: 0,
    },
  };
}

function llmFixture(overrides: Record<string, unknown> = {}) {
  return {
    window: "1h",
    from: "2026-11-04T11:00:00.000Z",
    to: "2026-11-04T12:00:00.000Z",
    grid: [
      { lane: "executor", model: "claude-opus-4-1", provider: "anthropic", eventCount: 3, inputTokens: 1_200, outputTokens: 300, cachedTokens: 4_800, cacheWriteTokens: 0, totalTokens: 6_300, cacheReadReported: true },
      { lane: "executor", model: "gpt-5", provider: "openai", eventCount: 1, inputTokens: 400, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 450, cacheReadReported: false },
      { lane: "heartbeat", model: "claude-opus-4-1", provider: "anthropic", eventCount: 2, inputTokens: 500, outputTokens: 20, cachedTokens: 2_500, cacheWriteTokens: 0, totalTokens: 3_020, cacheReadReported: true },
    ],
    aggregates: [
      laneAggregate({ lane: "executor", requests: 4, promptTokens: 6_400, cached: 4_800, reported: true, distinctHeads: 1, diverged: 0 }),
      laneAggregate({ lane: "heartbeat", requests: 2, promptTokens: 3_000, cached: 2_500, reported: true, distinctHeads: 1, diverged: 0 }),
      laneAggregate({ lane: "merger", requests: 1, promptTokens: 900, cached: 0, reported: false, distinctHeads: 2, diverged: 1 }),
    ],
    totalPromptTokens: 10_300,
    heartbeatPromptTokenShare: 3_000 / 10_300,
    headEvents: [],
    gridTruncated: false,
    headTruncated: false,
    ...overrides,
  };
}

const HEADS = [
  {
    id: 1,
    ts: "2026-11-04T11:42:07.000Z",
    lane: "executor",
    requestId: "req-1",
    headHash: "a".repeat(64),
    headBytes: 4_096,
    staticBytes: 4_032,
    dynamicBytes: 64,
    dynamicStart: 4_032,
    divergenceStatus: "baseline",
    firstDivergenceOffset: null,
    source: "pi-extension",
    runtimeId: "runtime-1",
  },
  {
    id: 2,
    ts: "2026-11-04T11:43:07.000Z",
    lane: "heartbeat",
    requestId: "req-2",
    headHash: "b".repeat(64),
    headBytes: 2_048,
    staticBytes: 1_984,
    dynamicBytes: 64,
    dynamicStart: 1_984,
    divergenceStatus: "diverged",
    firstDivergenceOffset: 1_512,
    source: "pi-extension",
    runtimeId: "runtime-2",
  },
];

/** Route the two endpoints the area now fetches, so a fixture for one cannot masquerade as the other. */
function routeResponses(llm: unknown) {
  apiMock.mockImplementation(async (path: string) => {
    if (typeof path === "string" && path.includes("llm-telemetry")) return llm;
    return tokenFixture();
  });
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TokensArea LLM telemetry section", () => {
  it("renders one row per lane the payload names, not a fixed lane list", async () => {
    routeResponses(llmFixture());
    render(<TokensArea range={range7d} />);

    expect(await screen.findByTestId("cc-llm-row-executor")).toBeInTheDocument();
    expect(screen.getByTestId("cc-llm-row-heartbeat")).toBeInTheDocument();
    expect(screen.getByTestId("cc-llm-row-merger")).toBeInTheDocument();
    expect(screen.getByTestId("cc-llm-cell-executor-claude-opus-4-1")).toHaveTextContent("6,300");
  });

  it("shows an unmeasured cache share as unmeasured instead of 0%", async () => {
    routeResponses(llmFixture());
    render(<TokensArea range={range7d} />);

    const mergerRow = await screen.findByTestId("cc-llm-row-merger");
    expect(mergerRow).toHaveTextContent("unmeasured");
    expect(mergerRow).not.toHaveTextContent("0.0%");
    // A measured lane in the same payload still prints its percentage, so the label is lane-specific.
    expect(screen.getByTestId("cc-llm-row-executor")).toHaveTextContent("75.0%");
  });

  it("re-fetches on the 10m window when the operator switches the axis", async () => {
    routeResponses(llmFixture());
    render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-llm-grid");

    fireEvent.click(screen.getByTestId("cc-llm-window-10m"));

    expect(await screen.findByTestId("cc-llm-window-10m")).toHaveAttribute("aria-pressed", "true");
    const llmPaths = apiMock.mock.calls.map((call) => String(call[0])).filter((p) => p.includes("llm-telemetry"));
    expect(llmPaths.some((p) => p.includes("window=1h"))).toBe(true);
    expect(llmPaths.some((p) => p.includes("window=10m"))).toBe(true);
  });

  it("renders its own empty sentence for a window with no lane rows, never a plate of zeroes", async () => {
    routeResponses(llmFixture({ aggregates: [], grid: [], totalPromptTokens: 0, heartbeatPromptTokenShare: null }));
    render(<TokensArea range={range7d} />);

    expect(await screen.findByTestId("cc-llm-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("cc-llm-grid")).not.toBeInTheDocument();
    // The board-spend totals this section sits beside keep rendering — the sections are independent.
    expect(screen.getByTestId("cc-tokens-total")).toHaveTextContent("1,000");
  });

  it("survives a payload without an aggregates array rather than taking the token area down", async () => {
    // The neighbouring harness style resolves every endpoint with the token fixture; the section must
    // degrade to its empty sentence instead of throwing inside render.
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} />);

    expect(await screen.findByTestId("cc-llm-empty")).toBeInTheDocument();
    expect(screen.getByTestId("cc-tokens-total")).toBeInTheDocument();
  });

  it("makes every spend tile a press target that says what it will show", async () => {
    // FNXC:LaneTelemetry 2026-11-04-07:20: a spend tile must be operable, not just readable.
    routeResponses(llmFixture());
    render(<TokensArea range={range7d} />);

    const tile = await screen.findByRole("button", {
      name: /executor on claude-opus-4-1: 6[.,]300 tokens over 3 requests/i,
    });
    expect(tile).toHaveAttribute("aria-pressed", "false");
    expect(tile).toHaveTextContent("6,300");
  });

  it("filters the prompt-head list to the pressed lane and clears again", async () => {
    routeResponses(llmFixture({ headEvents: HEADS }));
    render(<TokensArea range={range7d} />);

    expect(await screen.findByTestId("cc-llm-head-1")).toBeInTheDocument();
    expect(screen.getByTestId("cc-llm-head-2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /executor on claude-opus-4-1/i }));

    expect(screen.getByTestId("cc-llm-head-1")).toBeInTheDocument();
    expect(screen.queryByTestId("cc-llm-head-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("cc-llm-heads-clear")).toHaveTextContent("executor");

    fireEvent.click(screen.getByTestId("cc-llm-heads-clear"));
    expect(screen.getByTestId("cc-llm-head-2")).toBeInTheDocument();
  });

  it("expands a head row to its hash and divergence offsets without ever showing prompt text", async () => {
    routeResponses(llmFixture({ headEvents: [HEADS[1]] }));
    render(<TokensArea range={range7d} />);

    const toggle = (await screen.findByText("b".repeat(12))).closest("button");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle as HTMLElement);

    expect(toggle as HTMLElement).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("b".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("First divergence offset")).toBeInTheDocument();
    expect(screen.getByText("1512")).toBeInTheDocument();
    // Nothing but the closed vocabulary renders here, because a stored head body would surface as prose.
    const headsBox = screen.getByTestId("cc-llm-heads").textContent ?? "";
    expect(headsBox).not.toMatch(/You are|instructions/i);
  });

  it("names the lane when the pressed lane recorded no prompt head", async () => {
    routeResponses(llmFixture({ headEvents: [HEADS[0]] }));
    render(<TokensArea range={range7d} />);

    fireEvent.click(await screen.findByRole("button", { name: /heartbeat on claude-opus-4-1: .*prompt heads/i }));

    expect(await screen.findByTestId("cc-llm-heads-empty")).toHaveTextContent("heartbeat");
  });

  it("reports median system bytes and the offset-bucket split per lane", async () => {
    const base = laneAggregate({ lane: "executor", requests: 4, promptTokens: 6_400, cached: 4_800, reported: true, distinctHeads: 1, diverged: 2 });
    const aggregate = { ...base, head: { ...base.head, medianHeadBytes: null, offsetUnknownCount: 1 } };
    routeResponses(llmFixture({ aggregates: [aggregate] }));
    render(<TokensArea range={range7d} />);

    expect(await screen.findByTestId("cc-llm-divergence-executor")).toHaveTextContent("2");
    const row = screen.getByTestId("cc-llm-row-executor");
    expect(row).toHaveTextContent("unmeasured");
    expect(row).toHaveTextContent("2 localised, 1 not");
  });
});
