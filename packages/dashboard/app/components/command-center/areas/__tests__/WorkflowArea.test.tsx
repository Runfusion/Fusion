import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { DateRange } from "../../DateRangePicker";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock("../../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  api: (path: string, opts?: RequestInit) => mocks.api(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
}));

import { WorkflowArea } from "../WorkflowArea";

const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };

function emptyWorkflowFixture() {
  return {
    from: null,
    to: null,
    totals: {
      tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
      cost: { usd: null, unavailable: false, stale: false },
      filesChanged: 0,
      tasksCompleted: 0,
      tasksInProgress: 0,
      tasksInReview: 0,
    },
    workflows: [],
  };
}

function populatedWorkflowFixture() {
  return {
    ...emptyWorkflowFixture(),
    totals: {
      tokens: { inputTokens: 1000, outputTokens: 500, cachedTokens: 150, cacheWriteTokens: 0, totalTokens: 1650, nTasks: 3 },
      cost: { usd: 4.25, unavailable: true, stale: false },
      filesChanged: 9,
      tasksCompleted: 4,
      tasksInProgress: 1,
      tasksInReview: 1,
    },
    workflows: [
      {
        workflowId: "builtin:coding",
        workflowName: "Coding",
        isBuiltin: true,
        tokens: { inputTokens: 900, outputTokens: 450, cachedTokens: 150, cacheWriteTokens: 0, totalTokens: 1500, nTasks: 2 },
        cost: { usd: 4.25, unavailable: false, stale: false },
        filesChanged: 7,
        tasksCompleted: 3,
        tasksInProgress: 1,
        tasksInReview: 0,
      },
      {
        workflowId: "WF-unpriced",
        workflowName: "Unpriced Workflow",
        isBuiltin: false,
        tokens: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 150, nTasks: 1 },
        cost: { usd: null, unavailable: true, stale: false },
        filesChanged: 2,
        tasksCompleted: 1,
        tasksInProgress: 0,
        tasksInReview: 1,
      },
    ],
  };
}

beforeEach(() => {
  mocks.api.mockReset();
});

describe("WorkflowArea", () => {
  it("appends projectId to its workflows request when supplied, and omits it when not", async () => {
    mocks.api.mockResolvedValue(emptyWorkflowFixture());
    const { unmount } = render(<WorkflowArea range={range7d} projectId="proj-wf" />);
    await screen.findByTestId("cc-area-workflows-empty");
    expect(mocks.api.mock.calls.at(-1)?.[0]).toBe("/command-center/workflows?from=2026-06-08&projectId=proj-wf");
    unmount();

    mocks.api.mockClear();
    mocks.api.mockResolvedValue(emptyWorkflowFixture());
    render(<WorkflowArea range={range7d} />);
    await screen.findByTestId("cc-area-workflows-empty");
    expect(mocks.api.mock.calls.at(-1)?.[0]).toBe("/command-center/workflows?from=2026-06-08");
  });

  it("renders loading, empty, and error states through AreaShell", async () => {
    let resolveWorkflows: (value: unknown) => void = () => undefined;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { resolveWorkflows = resolve; }));
    const { unmount } = render(<WorkflowArea range={range7d} />);

    expect(screen.getByTestId("cc-area-workflows-loading")).toBeTruthy();
    resolveWorkflows(emptyWorkflowFixture());
    await screen.findByTestId("cc-area-workflows-empty");
    unmount();

    mocks.api.mockRejectedValueOnce(new Error("workflow failed"));
    render(<WorkflowArea range={range7d} />);
    await screen.findByTestId("cc-area-workflows-error");
    expect(screen.getByTestId("cc-area-workflows-error").textContent).toContain("workflow failed");
  });

  it("renders per-workflow totals, charts, and table rows without showing unavailable cost as zero", async () => {
    mocks.api.mockResolvedValueOnce(populatedWorkflowFixture());
    render(<WorkflowArea range={range7d} />);

    await screen.findByTestId("cc-area-workflows");
    expect(mocks.api).toHaveBeenCalledWith("/command-center/workflows?from=2026-06-08", undefined);
    expect(screen.getByTestId("cc-workflows-total-tokens").textContent).toContain("1,650");
    expect(screen.getByTestId("cc-workflows-total-cost").textContent).toContain("$4.25+");
    expect(screen.getByTestId("cc-workflows-tokens-chart").textContent).toContain("Coding");

    const table = screen.getByTestId("cc-workflows-table");
    expect(within(table).getByText("Coding")).toBeTruthy();
    expect(within(table).getByText("Unpriced Workflow")).toBeTruthy();
    expect(screen.getByTestId("cc-workflows-row-builtin:coding").textContent).toContain("$4.25");
    const unpricedRow = screen.getByTestId("cc-workflows-row-WF-unpriced");
    expect(unpricedRow.textContent).toContain("—");
    expect(unpricedRow.textContent).not.toContain("$0");
  });

  it("keeps chart rendering safe when workflows have zero-valued metrics", async () => {
    mocks.api.mockResolvedValueOnce({
      ...emptyWorkflowFixture(),
      workflows: [
        {
          workflowId: "WF-zero",
          workflowName: "Zero Workflow",
          isBuiltin: false,
          tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
          cost: { usd: null, unavailable: false, stale: false },
          filesChanged: 0,
          tasksCompleted: 0,
          tasksInProgress: 0,
          tasksInReview: 0,
        },
      ],
    });
    render(<WorkflowArea range={range7d} />);

    await screen.findByTestId("cc-area-workflows");
    expect(screen.getByTestId("cc-workflows-tokens-chart").textContent).toContain("No non-zero values");
    expect(screen.getByTestId("cc-workflows-completed-chart").textContent).toContain("No non-zero values");
    expect(screen.getByTestId("cc-area-workflows").textContent).not.toContain("NaN");
  });
});
