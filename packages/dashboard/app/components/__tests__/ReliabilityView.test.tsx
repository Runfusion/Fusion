import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
vi.mock("../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
}));

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

function renderInProjectContent(projectId?: string) {
  return render(
    <div
      data-testid="project-content"
      style={{ display: "flex", flex: "1 1 auto", height: "100%", minHeight: 0, minWidth: 0, width: "100%", overflow: "hidden" }}
    >
      <ReliabilityView projectId={projectId} />
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
    apiMock.mockReset();
  });

  it("shows loading spinner while data is loading", () => {
    apiMock.mockReturnValue(new Promise(() => {}));

    render(<ReliabilityView />);

    expect(screen.getByTestId("reliability-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading reliability data...")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reliability" })).not.toBeInTheDocument();
  });

  it("shows error message when the api client rejects", async () => {
    apiMock.mockRejectedValue(new Error("Network unavailable"));

    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByTestId("reliability-error")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable");
    expect(screen.queryByRole("heading", { name: "Reliability" })).not.toBeInTheDocument();
  });

  it("uses the shared api() client (carrying auth) instead of raw fetch, and appends projectId when supplied", async () => {
    apiMock.mockResolvedValue(baseResponse);

    const { unmount } = render(<ReliabilityView />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls[0]?.[0]).toBe("/health/reliability");
    unmount();

    apiMock.mockClear();
    apiMock.mockResolvedValue(baseResponse);
    render(<ReliabilityView projectId="proj-xyz" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls[0]?.[0]).toBe("/health/reliability?projectId=proj-xyz");
  });

  it.each([
    ["desktop", 1024],
    ["mobile", 375],
  ])("fills flex parent width and height in %s loading state", (_label, width) => {
    setViewportWidth(width);
    apiMock.mockReturnValue(new Promise(() => {}));

    renderInProjectContent();

    expectFlexFill(screen.getByTestId("reliability-loading"));
  });

  it.each([
    ["desktop", 1024],
    ["mobile", 375],
  ])("fills flex parent width and height in %s populated state", async (_label, width) => {
    setViewportWidth(width);
    apiMock.mockResolvedValue(baseResponse);

    const { container } = renderInProjectContent();

    await waitFor(() => expect(container.querySelector(".reliability-view")).not.toBeNull());
    expectFlexFill(container.querySelector(".reliability-view") as HTMLElement);
  });

  it.each([
    ["desktop", 1024],
    ["mobile", 375],
  ])("fills flex parent width and height in %s error state", async (_label, width) => {
    setViewportWidth(width);
    apiMock.mockRejectedValue(new Error("Network unavailable"));

    renderInProjectContent();

    await waitFor(() => expect(screen.getByTestId("reliability-error")).toBeInTheDocument());
    expectFlexFill(screen.getByTestId("reliability-error"));
  });

  it("shows data after successful load even if loading refresh is pending", async () => {
    vi.useFakeTimers();
    apiMock
      .mockResolvedValueOnce(baseResponse)
      .mockReturnValueOnce(new Promise(() => {}));

    render(<ReliabilityView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("80.0%")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("80.0%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reliability" })).toBeInTheDocument();
    expect(screen.queryByTestId("reliability-loading")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("renders headline percent and details disclosure", async () => {
    apiMock.mockResolvedValue(baseResponse);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("80.0%")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("2 bounced / 10 entered (last 7d)")).toBeInTheDocument();
  });

  it("hides zero-sample days by default and reveals with toggle", async () => {
    apiMock.mockResolvedValue(baseResponse);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("2026-05-13")).toBeInTheDocument());
    expect(screen.queryByText("2026-05-12")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show empty days" }));
    expect(screen.getByText("2026-05-12")).toBeInTheDocument();
  });

  it("renders the in-review flow chart for populated reliability data", async () => {
    apiMock.mockResolvedValue(baseResponse);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByRole("img", { name: "In-review entered vs bounced per day" })).toBeInTheDocument());
    expect(within(screen.getByTestId("reliability-flow-chart")).queryByText("No in-review flow data")).not.toBeInTheDocument();
  });

  it("FN-8036: reflows all reliability metric cards from the content column width", async () => {
    apiMock.mockResolvedValue(baseResponse);
    const { container } = renderInProjectContent();

    await waitFor(() => expect(container.querySelector(".reliability-grid")).not.toBeNull());
    const grid = container.querySelector(".reliability-grid") as HTMLElement;

    expect(grid.querySelectorAll(":scope > .reliability-card")).toHaveLength(3);
    expect(getComputedStyle(grid).gridTemplateColumns).toContain("auto-fit");
    expect(getComputedStyle(grid).gridTemplateColumns).toContain("minmax");
  });

  it("renders the merge-attempts chart for populated reliability data", async () => {
    apiMock.mockResolvedValue(baseResponse);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByRole("img", { name: "Merge attempts histogram" })).toBeInTheDocument());
    expect(within(screen.getByTestId("reliability-merge-attempts-chart")).queryByText("No merge attempt data")).not.toBeInTheDocument();
  });

  it("renders chart empty states without throwing when reliability series are empty", async () => {
    apiMock.mockResolvedValue({
      ...baseResponse,
      headline: { inReviewFailureRate7d: null, reason: "no-in-review-entries" },
      perDay: [],
      mergeAttempts: { mean: null, max: null, histogram: {}, reason: "no-audit-coverage" },
    });

    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByRole("img", { name: "In-review entered vs bounced per day" })).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "Merge attempts histogram" })).toBeInTheDocument();
    expect(screen.getByText("No in-review flow data")).toBeInTheDocument();
    expect(screen.getByText("No merge attempt data")).toBeInTheDocument();
  });

  it("keeps the flow chart source consistent with the Show empty days table toggle", async () => {
    apiMock.mockResolvedValue({
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
    });

    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("2026-05-13")).toBeInTheDocument());
    expect(screen.queryByText("2026-05-12")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("reliability-flow-chart")).getByText("No in-review flow data")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show empty days" }));
    expect(screen.getByText("2026-05-12")).toBeInTheDocument();
    expect(within(screen.getByTestId("reliability-flow-chart")).queryByText("No in-review flow data")).not.toBeInTheDocument();
  });

  it("opens reset modal and confirms reset with refetch, both carrying projectId", async () => {
    apiMock
      .mockResolvedValueOnce(baseResponse)
      .mockResolvedValueOnce({ resetAt: "2026-05-13T01:00:00.000Z" })
      .mockResolvedValueOnce({ ...baseResponse, resetAt: "2026-05-13T01:00:00.000Z" });

    render(<ReliabilityView projectId="proj-reset" />);
    await waitFor(() => expect(screen.getByText("80.0%")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Reset stats" }));
    expect(screen.getByText("Reset reliability stats?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith("/health/reliability/reset?projectId=proj-reset", { method: "POST" });
    });
    await waitFor(() => expect(screen.getByText(/Counting since/)).toBeInTheDocument());
  });

  it("renders duration more-stats raw metrics", async () => {
    apiMock.mockResolvedValue(baseResponse);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("80.0%")).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("More stats")[0] as HTMLElement);
    expect(screen.getByText("P50 raw: 60000 ms")).toBeInTheDocument();
    expect(screen.getByText("Sample count: 3")).toBeInTheDocument();
  });

  it("FN-4594: root container provides vertical scroll contract", async () => {
    apiMock.mockResolvedValue({ ...baseResponse, perDay: [] });

    const { container } = render(<ReliabilityView />);
    await waitFor(() => expect(container.querySelector(".reliability-view")).not.toBeNull());
    const root = container.querySelector(".reliability-view") as HTMLElement;

    const computed = getComputedStyle(root);
    expect(computed.overflowY).toBe("auto");
    expect(computed.height).not.toBe("");
  });

  it("FN-4716: renders 100.0% when zero bounces", async () => {
    apiMock.mockResolvedValue({
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
    });

    render(<ReliabilityView />);
    await waitFor(() => expect(screen.getByText("100.0%")).toBeInTheDocument());
  });

  it("renders null headline reason gracefully", async () => {
    apiMock.mockResolvedValue({
      ...baseResponse,
      headline: { inReviewFailureRate7d: null, reason: "no-in-review-entries" },
      duration: { p50Ms: null, p95Ms: null, sampleCount: 0, reason: "insufficient-samples" },
      mergeAttempts: { mean: null, max: null, histogram: {}, reason: "no-audit-coverage" },
    });

    render(<ReliabilityView />);
    await waitFor(() => expect(screen.getByText("Insufficient data — no-in-review-entries")).toBeInTheDocument());
  });
});
