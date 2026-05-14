import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReliabilityView } from "../ReliabilityView";

describe("ReliabilityView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders headline percent and per-day row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        windowDays: 7,
        generatedAt: "2026-05-13T00:00:00.000Z",
        headline: { inReviewFailureRate7d: 0.2 },
        perDay: [
          {
            date: "2026-05-13",
            tasksEnteredInReview: 10,
            tasksBouncedToInProgress: 2,
            postMergeAuditFailures: null,
            fileScopeInvariantFailures: null,
            recoverAlreadyMergedReviewTasksRecoveries: null,
          },
        ],
        duration: { p50Ms: 60_000, p95Ms: 120_000, sampleCount: 3 },
        mergeAttempts: { mean: 1.2, max: 2, histogram: { "1": 1 } },
      }),
    } as Response);

    render(<ReliabilityView />);

    await waitFor(() => {
      expect(screen.getByText("20.0%")).toBeInTheDocument();
    });
    expect(screen.getByText("2026-05-13")).toBeInTheDocument();
  });

  it("renders null headline reason gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        windowDays: 7,
        generatedAt: "2026-05-13T00:00:00.000Z",
        headline: { inReviewFailureRate7d: null, reason: "no-in-review-entries" },
        perDay: [],
        duration: { p50Ms: null, p95Ms: null, sampleCount: 0, reason: "insufficient-samples" },
        mergeAttempts: { mean: null, max: null, histogram: {}, reason: "no-audit-coverage" },
      }),
    } as Response);

    render(<ReliabilityView />);

    await waitFor(() => {
      expect(screen.getByText("Insufficient data — no-in-review-entries")).toBeInTheDocument();
    });
  });
});
