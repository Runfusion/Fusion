import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("ReliabilityView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders headline percent and details disclosure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => baseResponse } as Response);
    render(<ReliabilityView />);

    await waitFor(() => expect(screen.getByText("20.0%")).toBeInTheDocument());
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

  it("opens reset modal and confirms reset with refetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => baseResponse } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ resetAt: "2026-05-13T01:00:00.000Z" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...baseResponse, resetAt: "2026-05-13T01:00:00.000Z" }) } as Response);

    render(<ReliabilityView />);
    await waitFor(() => expect(screen.getByText("20.0%")).toBeInTheDocument());

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

    await waitFor(() => expect(screen.getByText("20.0%")).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("More stats")[0] as HTMLElement);
    expect(screen.getByText("P50 raw: 60000 ms")).toBeInTheDocument();
    expect(screen.getByText("Sample count: 3")).toBeInTheDocument();
  });

  it("FN-4594: root container provides vertical scroll contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ ...baseResponse, perDay: [] }) } as Response);

    const { container } = render(<ReliabilityView />);
    const root = container.querySelector(".reliability-view");
    expect(root).not.toBeNull();

    const computed = getComputedStyle(root as HTMLElement);
    expect(computed.overflowY).toBe("auto");
    expect(computed.height).not.toBe("");
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
