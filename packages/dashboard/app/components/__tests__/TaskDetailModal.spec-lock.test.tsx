import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";

setupTaskDetailModalHooks();

afterEach(async () => {
  const { fetchSpecLock } = await import("../../api");
  vi.mocked(fetchSpecLock).mockReset();
  vi.mocked(fetchSpecLock).mockResolvedValue({ latestLock: null, activeLock: null, currentPlan: null, report: null, latestReport: null, history: { locks: [], currentPlans: [], reports: [] } });
});

describe("TaskDetailModal spec-lock report", () => {
  it("renders persisted Mission-statement divergence and immutable provenance in the shared Definition surface", async () => {
    const { fetchSpecLock } = await import("../../api");
    vi.mocked(fetchSpecLock).mockResolvedValue({
      latestLock: {
        version: 1,
        acceptedAt: "2026-08-09T19:34:00.000Z",
        approvalFingerprint: "approved-hash",
        currentPlanVersion: 1,
        currentPlanHash: "plan-hash",
        plan: {} as never,
      },
      activeLock: null,
      currentPlan: {
        version: 2,
        sourceRevision: 42,
        sourceHash: "source-hash",
        capturedAt: "2026-08-09T19:35:00.000Z",
        plan: {} as never,
      },
      report: {
        lockVersion: 1,
        currentPlanVersion: 2,
        currentPlanHash: "changed-plan-hash",
        status: "available",
        findings: [{ kind: "plan-deviation", category: "mission-statement", priorHash: "prior", currentHash: "current" }],
        alignment: "diverged-needs-review",
        executionHash: "execution",
        reportHash: "report",
      },
      latestReport: null,
      history: { locks: [{ version: 1 }], currentPlans: [{ version: 1 }, { version: 2 }], reports: [{}, {}] },
    } as never);

    render(
      <TaskDetailContent
        initialTab="definition"
        active
        task={makeTask({ prompt: "## Mission\n\nChanged" })}
        onRequestClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={vi.fn()}
        onTaskUpdated={vi.fn()}
      />,
    );

    const report = await screen.findByTestId("spec-lock-report");
    expect(report).toHaveAccessibleName("Spec lock alignment");
    expect(report).toHaveTextContent("diverged-needs-review");
    expect(report).toHaveTextContent("plan-deviation: mission-statement");
    expect(report).toHaveTextContent("source revision 42");
    expect(report).toHaveTextContent("source hash source-hash");
    expect(report).toHaveTextContent("Retained history: lock v1; plan v1, plan v2; 2 reports");
    for (const heading of ["Progress", "Original prompt", "Dependencies", "Blocking"]) {
      const anchor = screen.getByText(heading, { exact: true });
      expect(anchor.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await waitFor(() => expect(fetchSpecLock).toHaveBeenCalledWith("FN-099", undefined));
  });

  it("keeps an unavailable all-null report at the end without rendering findings", async () => {
    const { fetchSpecLock } = await import("../../api");
    vi.mocked(fetchSpecLock).mockResolvedValue({
      latestLock: null,
      activeLock: null,
      currentPlan: null,
      report: null,
      latestReport: null,
      history: { locks: [], currentPlans: [], reports: [] },
    });

    render(
      <TaskDetailContent
        initialTab="definition"
        active
        task={makeTask()}
        onRequestClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={vi.fn()}
        onTaskUpdated={vi.fn()}
      />,
    );

    const report = await screen.findByTestId("spec-lock-report");
    expect(report).toHaveTextContent("unavailable");
    expect(report).toHaveTextContent("v—");
    expect(report.querySelector(".spec-lock-findings")).toBeNull();
    const blocking = screen.getByText("Blocking", { exact: true });
    expect(blocking.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not leave a spec-lock shell when no spec-lock data exists", async () => {
    const { fetchSpecLock } = await import("../../api");
    vi.mocked(fetchSpecLock).mockResolvedValue(null as never);

    render(
      <TaskDetailContent
        initialTab="definition"
        active
        task={makeTask()}
        onRequestClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={vi.fn()}
        onTaskUpdated={vi.fn()}
      />,
    );

    await waitFor(() => expect(fetchSpecLock).toHaveBeenCalledWith("FN-099", undefined));
    expect(screen.queryByTestId("spec-lock-report")).toBeNull();
    expect(screen.getByText("Dependencies", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Blocking", { exact: true })).toBeInTheDocument();
  });
});
