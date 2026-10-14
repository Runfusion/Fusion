import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TaskIdIntegrityBanner } from "../TaskIdIntegrityBanner";
import type { DashboardHealthResponse } from "../../api/client/health";

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

  /*
  FNXC:TaskIdIntegrityCanary 2026-09-26-02:22 (RUFU-301):
  RUFU-301 acceptance — "UI shows NOT-VERIFIED distinctly from clean and corrupt"
  and "a timeout-forced probe payload is distinguishable from a clean probe". The
  unmeasured case previously rendered *nothing* (the banner was gated on
  `status === "anomaly"`), which is how a probe that never finished its queries
  stayed invisible while `/api/health` published `corruptionDetected: false`. These
  cases pin the three states apart: clean renders no banner, unmeasured renders a
  polite warning naming the probe error, and an anomaly keeps its assertive alert.
  */
  const unmeasuredReport = {
    status: "error" as const,
    checkedAt: "2026-09-26T02:22:00.000Z",
    anomalies: [] as [],
    error:
      "PostgreSQL task-ID integrity probe did not complete within its 4750ms stage budget (4751ms elapsed of a 5000ms probe)",
    failure: "incomplete" as const,
    recommendedAction:
      "PostgreSQL answered, but the task-ID integrity measurement did not finish inside its budget, so no verdict was measured.",
  };

  it("renders a NOT-VERIFIED warning when the measurement never finished", () => {
    render(
      <TaskIdIntegrityBanner
        report={unmeasuredReport}
        recommendedAction={unmeasuredReport.recommendedAction}
      />,
    );

    expect(screen.getByText("Task ID integrity could not be measured")).toBeInTheDocument();
    // The copy must refuse to read as a pass.
    expect(screen.getByText(/This is not a clean result/)).toBeInTheDocument();
    // The probe's own sentence is surfaced so a cancellation is distinguishable
    // from a connection loss without opening devtools.
    expect(screen.getByText(/did not complete within its 4750ms stage budget/)).toBeInTheDocument();
    // Warning, not alarm: PostgreSQL may be perfectly healthy.
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Task ID integrity anomaly detected")).toBeNull();
  });

  /*
  FNXC:TaskIdIntegrityCanary 2026-09-26-04:38 (RUFU-301):
  Code-review P1. The NOT-VERIFIED body used to be one hardcoded sentence for every
  `status: "error"` class, so it told an operator "Fusion reached PostgreSQL" in the
  two states where the payload says the opposite — `unconfigured` (production-
  reachable today: no PostgreSQL health layer at all) and `unreachable` (the
  connection itself failed). That is the same false connectivity claim this task
  removes from the health payload. Each class now owns its copy, and only
  `incomplete` — where the connectivity stage measurably answered — may claim the
  server was reached. Exact-string assertions with the other classes' copy asserted
  absent, so the test cannot pass by rendering all three.
  */
  const notMeasuredBodyByClass = {
    incomplete:
      "Fusion reached PostgreSQL, but the task-ID integrity check did not finish, so there is no corruption verdict. This is not a clean result — the next health check retries automatically.",
    unreachable:
      "Fusion could not reach PostgreSQL, so the task-ID integrity check could not run. This is not a clean result — no corruption verdict was measured.",
    unconfigured:
      "No PostgreSQL health layer is available, so the task-ID integrity check could not run at all. This is not a clean result — the canary has never measured.",
  } as const;

  it.each(["incomplete", "unreachable", "unconfigured"] as const)(
    "states connectivity truthfully for an %s unmeasured probe",
    (failure) => {
      render(
        <TaskIdIntegrityBanner
          report={{ ...unmeasuredReport, failure }}
          recommendedAction={unmeasuredReport.recommendedAction}
        />,
      );

      expect(screen.getByText(notMeasuredBodyByClass[failure])).toBeInTheDocument();
      for (const other of ["incomplete", "unreachable", "unconfigured"] as const) {
        if (other === failure) continue;
        expect(screen.queryByText(notMeasuredBodyByClass[other])).toBeNull();
      }
      // Every class still refuses to read as a pass and still shows the probe error.
      expect(screen.getByText(/This is not a clean result/)).toBeInTheDocument();
      expect(screen.getByText(/did not complete within its 4750ms stage budget/)).toBeInTheDocument();
    },
  );

  it("keeps a timeout-forced payload distinguishable from a clean probe", () => {
    const clean = render(
      <TaskIdIntegrityBanner report={{ status: "ok", checkedAt: "2026-09-26T02:22:00.000Z", anomalies: [] }} recommendedAction={null} />,
    );
    expect(clean.container).toBeEmptyDOMElement();
    clean.unmount();

    const unmeasured = render(
      <TaskIdIntegrityBanner report={unmeasuredReport} recommendedAction={unmeasuredReport.recommendedAction} />,
    );
    expect(unmeasured.getByRole("status")).toBeInTheDocument();
    unmeasured.unmount();

    const corrupt = render(<TaskIdIntegrityBanner report={anomalyReport} recommendedAction="Run the allocator audit." />);
    expect(corrupt.getByRole("alert")).toBeInTheDocument();
  });

  it("reports unverified again when a re-check still cannot measure", async () => {
    mockRefreshDashboardHealth.mockReset();
    mockRefreshDashboardHealth.mockResolvedValue({ taskIdIntegrity: unmeasuredReport });
    const onRefresh = vi.fn();

    render(
      <TaskIdIntegrityBanner
        report={unmeasuredReport}
        recommendedAction={unmeasuredReport.recommendedAction}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));

    await waitFor(() => {
      expect(mockRefreshDashboardHealth).toHaveBeenCalledTimes(1);
      // The refresh must not launder an unfinished measurement into a clean report.
      expect(onRefresh).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", failure: "incomplete" }),
        unmeasuredReport.recommendedAction,
      );
    });
  });

  it("keeps the wire canary non-nullable and the failure class enumerable", () => {
    // Compile-time parity with the server's `DashboardDatabaseHealth`: the boolean
    // is what fails closed, and the tri-state lives in `taskIdIntegrity`.
    expectTypeOf<DashboardHealthResponse["database"]["corruptionDetected"]>().toEqualTypeOf<boolean>();
    expectTypeOf<
      Extract<DashboardHealthResponse["taskIdIntegrity"], { status: "error" }>["failure"]
    >().toEqualTypeOf<"unconfigured" | "unreachable" | "incomplete" | undefined>();
    expect(typeof unmeasuredReport.failure).toBe("string");
  });
});
