import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TaskIdIntegrityBanner } from "../TaskIdIntegrityBanner";

const mockRefreshDashboardHealth = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api")>();
  return {
    ...original,
    refreshDashboardHealth: (...args: unknown[]) => mockRefreshDashboardHealth(...args),
  };
});

const anomalyReport = {
  status: "anomaly" as const,
  checkedAt: "2026-05-12T10:00:00.000Z",
  anomalies: [
    {
      kind: "next_sequence_at_or_below_used" as const,
      prefix: "FN",
      affectedIds: ["FN-100", "FN-101", "FN-102", "FN-103", "FN-104", "FN-105"],
      details: "Allocator state overlaps an existing task.",
    },
  ],
};

describe("TaskIdIntegrityBanner", () => {
  it("renders nothing when the report is healthy", () => {
    const { container } = render(
      <TaskIdIntegrityBanner
        report={{ status: "ok", checkedAt: "2026-05-12T10:00:00.000Z", anomalies: [] }}
        recommendedAction="Pause task delegation."
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the alert headline, affected IDs, and recommended action for anomalies", () => {
    render(
      <TaskIdIntegrityBanner
        report={anomalyReport}
        recommendedAction="Pause task delegation, inspect the affected task IDs, and run the allocator audit before creating new tasks."
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Task ID integrity anomaly detected")).toBeInTheDocument();
    expect(screen.getByText("FN-100, FN-101, FN-102, FN-103, FN-104 +1 more")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pause task delegation, inspect the affected task IDs, and run the allocator audit before creating new tasks.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("re-checks health on demand", async () => {
    mockRefreshDashboardHealth.mockResolvedValueOnce({
      status: "ok",
      version: "1.0.0",
      uptime: 1,
      database: {
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: null,
        isRunning: false,
      },
      taskIdIntegrity: {
        status: "ok",
        checkedAt: "2026-05-12T10:05:00.000Z",
        anomalies: [],
        recommendedAction: null,
      },
    });
    const onRefresh = vi.fn();

    render(
      <TaskIdIntegrityBanner
        report={anomalyReport}
        recommendedAction="Pause task delegation."
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));

    await waitFor(() => {
      expect(mockRefreshDashboardHealth).toHaveBeenCalledTimes(1);
      expect(onRefresh).toHaveBeenCalledWith(
        { status: "ok", checkedAt: "2026-05-12T10:05:00.000Z", anomalies: [], recommendedAction: null },
        null,
      );
    });
  });
});
