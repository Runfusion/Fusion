import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReliabilityView } from "../ReliabilityView";

const baseResponse = {
  windowDays: 7,
  generatedAt: "2026-05-13T00:00:00.000Z",
  resetAt: null,
  headline: { inReviewFailureRate7d: 0.2 },
  perDay: [
    {
      date: "2026-05-12",
      tasksEnteredInReview: 0,
      tasksBouncedToInProgress: 0,
      postMergeAuditFailures: null,
      fileScopeInvariantFailures: null,
      recoverAlreadyMergedReviewTasksRecoveries: null,
      hasSamples: false,
    },
    {
      date: "2026-05-13",
      tasksEnteredInReview: 10,
      tasksBouncedToInProgress: 2,
      postMergeAuditFailures: null,
      fileScopeInvariantFailures: null,
      recoverAlreadyMergedReviewTasksRecoveries: null,
      hasSamples: true,
    },
  ],
  duration: { p50Ms: 60_000, p95Ms: 120_000, sampleCount: 3 },
  mergeAttempts: { mean: 1.2, max: 2, histogram: { "1": 1 } },
};

function renderInProjectContent() {
  return render(
    <div
      data-testid="project-content"
      style={{ display: "flex", flex: "1 1 auto", height: "100%", minHeight: 0, minWidth: 0, width: "100%", overflow: "hidden" }}
    >
      <ReliabilityView />
    </div>,
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

function expectFlexFill(element: HTMLElement) {
  const computed = getComputedStyle(element);
  expect(computed.flexGrow).toBe("1");
  expect(computed.flexShrink).toBe("1");
  expect(computed.flexBasis).toBe("auto");
  expect(computed.height).not.toBe("");
  expect(computed.height).not.toBe("0px");
  expect(computed.height).not.toBe("auto");
  expect(computed.minWidth).toBe("0px");
}

describe("ReliabilityView", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows loading spinner while data is loading", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));

    render(<ReliabilityView />);

    expect(screen.getByTestId("reliability-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading reliability data...")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reliability" })).not.toBeInTheDocument();
  });

  it("shows error message when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network unavailable"));

    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByTestId("reliability-error")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable");
    expect(screen.queryByRole("heading", { name: "Reliability" })).not.toBeInTheDocument();
  });

  it.each([
    ["desktop", 1024],
    ["mobile", 375],
  ])("fills flex parent width and height in %s loading state", (_label, width) => {
    setViewportWidth(width);
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));

    renderInProjectContent();

    expectFlexFill(screen.getByTestId("reliability-loading"));
  });

  it.each([
    ["desktop", 1024],
    ["mobile", 375],
  ])("fills flex parent width and height in %s populated state", async (_label, width) => {
    setViewportWidth(width);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => baseResponse } as Response);

    const { container } = renderInProjectContent();

    await waitFor(() => expect(container.querySelector(".reliability-view")).not.toBeNull());
    expectFlexFill(container.querySelector(".reliability-view") as HTMLElement);
  });

  it.each([
    ["desktop", 1024],
    ["mobile", 375],
  ])("fills flex parent width and height in %s error state", async (_label, width) => {
    setViewportWidth(width);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network unavailable"));

    renderInProjectContent();

    await waitFor(() => expect(screen.getByTestId("reliability-error")).toBeInTheDocument());
    expectFlexFill(screen.getByTestId("reliability-error"));
  });

  it("shows data after successful load even if loading refresh is pending", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => baseResponse } as Response)
      .mockReturnValueOnce(new Promise<Response>(() => {}));

    render(<ReliabilityView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("80.0%")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("80.0%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reliability" })).toBeInTheDocument();
    expect(screen.queryByTestId("reliability-loading")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders headline percent and details disclosure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => baseResponse } as Response);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("80.0%")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("2 bounced / 10 entered (last 7d)")).toBeInTheDocument();
  });

  it("hides zero-sample days by default and reveals with toggle", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => baseResponse } as Response);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("2026-05-13")).toBeInTheDocument());
    expect(screen.queryByText("2026-05-12")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show empty days" }));
    expect(screen.getByText("2026-05-12")).toBeInTheDocument();
  });

  it("renders the in-review flow chart for populated reliability data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => baseResponse } as Response);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByRole("img", { name: "In-review entered vs bounced per day" })).toBeInTheDocument());
    expect(within(screen.getByTestId("reliability-flow-chart")).queryByText("No in-review flow data")).not.toBeInTheDocument();
  });

  it("renders the merge-attempts chart for populated reliability data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => baseResponse } as Response);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByRole("img", { name: "Merge attempts histogram" })).toBeInTheDocument());
    expect(within(screen.getByTestId("reliability-merge-attempts-chart")).queryByText("No merge attempt data")).not.toBeInTheDocument();
  });

  it("renders chart empty states without throwing when reliability series are empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ...baseResponse,
        headline: { inReviewFailureRate7d: null, reason: "no-in-review-entries" },
        perDay: [],
        mergeAttempts: { mean: null, max: null, histogram: {}, reason: "no-audit-coverage" },
      }),
    } as Response);

    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByRole("img", { name: "In-review entered vs bounced per day" })).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "Merge attempts histogram" })).toBeInTheDocument();
    expect(screen.getByText("No in-review flow data")).toBeInTheDocument();
    expect(screen.getByText("No merge attempt data")).toBeInTheDocument();
  });

  it("keeps the flow chart source consistent with the Show empty days table toggle", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ...baseResponse,
        perDay: [
          {
            date: "2026-05-12",
            tasksEnteredInReview: 4,
            tasksBouncedToInProgress: 1,
            postMergeAuditFailures: null,
            fileScopeInvariantFailures: null,
            recoverAlreadyMergedReviewTasksRecoveries: null,
            hasSamples: false,
          },
          {
            date: "2026-05-13",
            tasksEnteredInReview: 0,
            tasksBouncedToInProgress: 0,
            postMergeAuditFailures: null,
            fileScopeInvariantFailures: null,
            recoverAlreadyMergedReviewTasksRecoveries: null,
            hasSamples: true,
          },
        ],
      }),
    } as Response);

    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("2026-05-13")).toBeInTheDocument());
    expect(screen.queryByText("2026-05-12")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("reliability-flow-chart")).getByText("No in-review flow data")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show empty days" }));
    expect(screen.getByText("2026-05-12")).toBeInTheDocument();
    expect(within(screen.getByTestId("reliability-flow-chart")).queryByText("No in-review flow data")).not.toBeInTheDocument();
  });

  it("opens reset modal and confirms reset with refetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => baseResponse } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ resetAt: "2026-05-13T01:00:00.000Z" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...baseResponse, resetAt: "2026-05-13T01:00:00.000Z" }) } as Response);

    render(<ReliabilityView />);
    await waitFor(() => expect(screen.getByText("80.0%")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Reset stats" }));
    expect(screen.getByText("Reset reliability stats?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/health/reliability/reset", { method: "POST" });
    });
    await waitFor(() => expect(screen.getByText(/Counting since/)).toBeInTheDocument());
  });

  it("renders duration more-stats raw metrics", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => baseResponse } as Response);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("80.0%")).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("More stats")[0] as HTMLElement);
    expect(screen.getByText("P50 raw: 60000 ms")).toBeInTheDocument();
    expect(screen.getByText("Sample count: 3")).toBeInTheDocument();
  });

  it("FN-4594: root container provides vertical scroll contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ ...baseResponse, perDay: [] }) } as Response);

    const { container } = render(<ReliabilityView />);
    await waitFor(() => expect(container.querySelector(".reliability-view")).not.toBeNull());
    const root = container.querySelector(".reliability-view") as HTMLElement;

    const computed = getComputedStyle(root);
    expect(computed.overflowY).toBe("auto");
    expect(computed.height).not.toBe("");
  });

  it("FN-4716: renders 100.0% when zero bounces", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ...baseResponse,
        headline: { inReviewFailureRate7d: 0 },
        perDay: [
          {
            date: "2026-05-13",
            tasksEnteredInReview: 5,
            tasksBouncedToInProgress: 0,
            postMergeAuditFailures: null,
            fileScopeInvariantFailures: null,
            recoverAlreadyMergedReviewTasksRecoveries: null,
            hasSamples: true,
          },
        ],
      }),
    } as Response);

    render(<ReliabilityView />);
    await waitFor(() => expect(screen.getByText("100.0%")).toBeInTheDocument());
  });

  it("renders null headline reason gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ...baseResponse,
        headline: { inReviewFailureRate7d: null, reason: "no-in-review-entries" },
        duration: { p50Ms: null, p95Ms: null, sampleCount: 0, reason: "insufficient-samples" },
        mergeAttempts: { mean: null, max: null, histogram: {}, reason: "no-audit-coverage" },
      }),
    } as Response);

    render(<ReliabilityView />);
    await waitFor(() => expect(screen.getByText("Insufficient data — no-in-review-entries")).toBeInTheDocument());
  });
});
