/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity and keeps it as the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Activity landing state.

FNXC:TaskDetailFooterActions 2026-09-05-23:27:
FN-300 keeps one footer Actions trigger and moves Quick Add controls into its labeled list. Match the trigger by its exact accessible name so action items with descriptive labels cannot make menu-opening queries ambiguous.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, cleanup, within } from "@testing-library/react";

// FNXC:Markdown 2026-06-23-03:30: Mock the heavy `mermaid` library so the shared
// markdown pipeline's MermaidDiagram resolves without loading the real renderer.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mock-mermaid-svg'></svg>" }),
  },
}));
import userEvent from "@testing-library/user-event";

import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  noopRetry,
  mockConfirm,
  mockUsePluginUiSlots,
  expectBaseRule,
  expectSingleStatsRuntimeStatus,
  readDashboardStylesSource,
  resetTaskDetailFetchMock,
  setupTaskDetailModalHooks,
  taskDetailSseSubscriptions,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal, TaskDetailContent } from "../TaskDetailModal";
import * as dashboardApi from "../../api";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import type { Task } from "@fusion/core";

setupTaskDetailModalHooks();

describe("TaskDetailModal", () => {
  /*
  FNXC:TaskDetailStateStability 2026-08-05-02:55:
  A real rendered detail host receives a newer queued-overlap detail and then the stale Todo row
  produced by a scheduler resync. Rerender without remounting proves the visible lifecycle badge
  never oscillates and the retained prompt/log survive the slim stale payload.
  */
  it("keeps the rendered queued-overlap lifecycle through a stale scheduler rerender", async () => {
    const queued = makeTask({
      id: "FN-QUEUED",
      column: "in-progress",
      status: "queued",
      overlapBlockedBy: "FN-OWNER",
      prompt: "# Preserved prompt",
      log: [{ timestamp: "2026-08-05T10:02:00.000Z", action: "Queued behind file overlap" }],
      updatedAt: "2026-08-05T10:02:00.000Z",
      columnMovedAt: "2026-08-05T10:02:00.000Z",
    });
    const staleTodo = makeTask({
      id: queued.id,
      column: "todo",
      status: undefined,
      prompt: undefined,
      log: [],
      updatedAt: "2026-08-05T10:00:00.000Z",
      columnMovedAt: "2026-08-05T10:00:00.000Z",
    });
    const props = {
      initialTab: "definition" as const,
      onClose: noop,

      onDeleteTask: noopDelete,
      onMergeTask: noopMerge,
      onOpenDetail: noopOpenDetail,
      addToast: noop,
    };

    const { rerender } = render(<TaskDetailModal {...props} task={queued} />);
    expect(document.querySelector(".detail-column-badge")).toHaveClass("badge-in-progress");

    rerender(<TaskDetailModal {...props} task={staleTodo} />);

    expect(document.querySelector(".detail-column-badge")).toHaveClass("badge-in-progress");
    expect(screen.getByText("Preserved prompt")).toBeInTheDocument();
  });

  /*
  FNXC:TaskDetailStateStability 2026-08-05-04:05:
  Definition ticks must not publish a full task snapshot. Drive repeated planning ticks against
  the production detail host and preserve the queued lifecycle and resolved workflow badge node.
  */
  it("keeps queued lifecycle and workflow badge continuous across active Details ticks", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValue({
        flagEnabled: true, defaultWorkflowId: "builtin:coding",
        workflows: [{ id: "builtin:coding", name: "Coding", columns: [], fields: [] }], taskWorkflowIds: {},
      });
      const promptFetch = vi.mocked(dashboardApi.fetchTaskPrompt);
      promptFetch.mockResolvedValue({ id: "FN-POLL", prompt: "# Updated definition" });
      const fullFetch = vi.mocked(dashboardApi.fetchTaskDetail);
      const queued = makeTask({ id: "FN-POLL", column: "in-progress", status: "queued", prompt: "# Initial definition", workflowStepResults: [{ workflowStepId: "plan-review", status: "running", startedAt: "2026-08-05T00:00:00.000Z" }] });
      render(<TaskDetailContent embedded active initialTab="details" task={queued} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} addToast={noop} />);

      await act(async () => {});
      const badge = screen.getByTestId("task-detail-workflow-badge");
      const initialPromptRequests = promptFetch.mock.calls.length;
      expect(document.querySelector(".detail-column-badge")).toHaveClass("badge-in-progress");
      for (let tick = 1; tick <= 3; tick++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(fullFetch).not.toHaveBeenCalled();
        expect(promptFetch).toHaveBeenCalledTimes(initialPromptRequests);
        expect(document.querySelector(".detail-column-badge")).toHaveClass("badge-in-progress");
        expect(screen.getByTestId("task-detail-workflow-badge")).toBe(badge);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  /*
  FNXC:TaskDetailStateStability 2026-08-05-05:01:
  Done cards use the same Definition timer as queued work. Keep both the resolved workflow badge and
  applicable Actions control mounted through every narrow response so the fix cannot merely hide the
  queued Todo rollback while completed-task controls still flash.
  */
  it("keeps done workflow badge and action controls continuous across active Details ticks", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValue({
        flagEnabled: true, defaultWorkflowId: "builtin:coding",
        workflows: [{ id: "builtin:coding", name: "Coding", columns: [], fields: [] }], taskWorkflowIds: {},
      });
      vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValue({ id: "FN-DONE-POLL", prompt: "# Refreshed definition" });
      const done = makeTask({ id: "FN-DONE-POLL", column: "done", status: "done", prompt: "# Original definition", workflowStepResults: [{ workflowStepId: "plan-review", status: "running", startedAt: "2026-08-05T00:00:00.000Z" }] });
      render(<TaskDetailContent embedded active initialTab="details" task={done} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} addToast={noop} />);

      await act(async () => {});
      const badge = screen.getByTestId("task-detail-workflow-badge");
      const actions = screen.getByRole("button", { name: "Actions" });
      const initialPromptRequests = vi.mocked(dashboardApi.fetchTaskPrompt).mock.calls.length;
      for (let tick = 1; tick <= 3; tick++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(dashboardApi.fetchTaskDetail).not.toHaveBeenCalled();
        expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledTimes(initialPromptRequests);
        expect(screen.getByTestId("task-detail-workflow-badge")).toBe(badge);
        expect(screen.getByRole("button", { name: "Actions" })).toBe(actions);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalidates column actions without clearing same-task workflow metadata", async () => {
    const payload = {
      flagEnabled: true, defaultWorkflowId: "wf-columns", taskWorkflowIds: {},
      workflows: [{ id: "wf-columns", name: "Column workflow", columns: [
        { id: "in-progress", name: "Building", flags: { countsTowardWip: true } },
        { id: "done", name: "Shipped", flags: { complete: true } },
      ], fields: [] }],
    };
    let settleColumnMove: (value: typeof payload) => void = () => undefined;
    vi.mocked(dashboardApi.fetchBoardWorkflows)
      .mockResolvedValueOnce(payload)
      .mockImplementationOnce(() => new Promise<typeof payload>((resolve) => { settleColumnMove = resolve; }));
    const task = makeTask({ id: "FN-COLUMN-MOVE", column: "in-progress", status: "queued" });
    const props = { embedded: true, active: true, initialTab: "details" as const, onDeleteTask: noopDelete, onMergeTask: noopMerge, onOpenDetail: noopOpenDetail, addToast: noop };
    const { rerender } = render(<TaskDetailContent {...props} task={task} />);

    const badge = await screen.findByTestId("task-detail-workflow-badge");
    const actions = screen.getByRole("button", { name: "Actions" });
    rerender(<TaskDetailContent {...props} task={{ ...task, column: "done", status: "done" }} />);

    expect(screen.getByTestId("task-detail-workflow-badge")).toBe(badge);
    expect(screen.getByRole("button", { name: "Actions" })).toBe(actions);
    await act(async () => { settleColumnMove(payload); });
  });

  it("keeps a prompt-only response when slim initial detail resolves later", async () => {
    let resolveDetail: (detail: TaskDetail) => void = () => undefined;
    vi.mocked(dashboardApi.fetchTaskDetail).mockImplementationOnce(() => new Promise<TaskDetail>((resolve) => {
      resolveDetail = resolve;
    }));
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValueOnce({ id: "FN-slim-prompt", prompt: "# Newer narrow prompt" });
    const slimTask = makeTask({ id: "FN-slim-prompt", prompt: undefined }) as Task;

    render(<TaskDetailContent embedded active initialTab="definition" task={slimTask} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} addToast={noop} />);
    await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledWith("FN-slim-prompt", undefined));

    await act(async () => {
      resolveDetail(makeTask({ id: "FN-slim-prompt", prompt: "# Older full prompt" }));
    });

    expect(await screen.findByText("Newer narrow prompt")).toBeInTheDocument();
    expect(screen.queryByText("Older full prompt")).toBeNull();
  });

  it("revalidates selected workflow metadata after its workflow SSE revision", async () => {
    vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValueOnce({
      flagEnabled: true, defaultWorkflowId: "builtin:coding",
      workflows: [{ id: "builtin:coding", name: "Coding", columns: [], fields: [] }],
      taskWorkflowIds: { "FN-workflow-revision": "builtin:coding" },
    });
    let resolveRevalidation: (payload: Awaited<ReturnType<typeof dashboardApi.fetchBoardWorkflows>>) => void = () => undefined;
    vi.mocked(dashboardApi.fetchBoardWorkflows).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRevalidation = resolve;
    }));
    render(<TaskDetailContent embedded active initialTab="details" task={makeTask({ id: "FN-workflow-revision", column: "todo" })} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} addToast={noop} />);

    expect(await screen.findByText("Coding")).toBeInTheDocument();
    const badge = screen.getByTestId("task-detail-workflow-badge");
    const workflowSubscription = taskDetailSseSubscriptions.find((subscription) => subscription.options.events?.["workflow:updated"]);
    expect(workflowSubscription).toBeDefined();

    await act(async () => {
      workflowSubscription?.options.events?.["workflow:updated"](new MessageEvent("workflow:updated"));
    });
    expect(screen.getByTestId("task-detail-workflow-badge")).toBe(badge);
    expect(screen.getByText("Coding")).toBeInTheDocument();

    await act(async () => {
      resolveRevalidation({
        flagEnabled: true, defaultWorkflowId: "wf-docs",
        workflows: [{ id: "wf-docs", name: "Docs", columns: [], fields: [] }],
        taskWorkflowIds: { "FN-workflow-revision": "wf-docs" },
      });
    });
    expect(await screen.findByText("Docs")).toBeInTheDocument();
  });

  describe("workflow timestamp badge", () => {
    const workflowPayload = {
      flagEnabled: true,
      defaultWorkflowId: "builtin:coding",
      workflows: [
        { id: "builtin:coding", name: "Coding", columns: [], fields: [{ id: "risk", name: "Risk", type: "text" }] },
        { id: "wf-docs", name: "Docs", columns: [] },
      ],
      taskWorkflowIds: { "FN-101": "wf-docs" },
    };

    beforeEach(() => {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockReset();
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValue({
        flagEnabled: false,
        defaultWorkflowId: "",
        workflows: [],
        taskWorkflowIds: {},
      });
    });

    function renderDetail(task = makeTask({ id: "FN-101", column: "todo", title: "Docs task" })) {
      return render(
        <TaskDetailModal
          initialTab="details"
          task={task}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
    }

    it("renders the resolved workflow name in the timestamp section instead of the title row", async () => {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValueOnce(workflowPayload);

      const { container } = renderDetail();

      const badge = await screen.findByTestId("task-detail-workflow-badge");
      expect(badge).toHaveTextContent("Docs");
      expect(badge.closest(".detail-timestamps")).toBeTruthy();
      expect(badge.closest(".detail-title-row")).toBeNull();
      expect(document.querySelector(".detail-title-row .detail-workflow-badge")).toBeNull();
      expect(screen.getAllByTestId("task-detail-workflow-badge")).toHaveLength(1);
      expect(screen.getByText("FN-101")).toBeInTheDocument();
      expect(screen.getByText("Todo")).toBeInTheDocument();
      expect(dashboardApi.fetchBoardWorkflows).toHaveBeenCalledTimes(1);
    });

    it("uses the default workflow for tasks without explicit workflow assignment", async () => {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValueOnce(workflowPayload);

      renderDetail(makeTask({ id: "FN-default", column: "todo", title: "Default workflow task" }));

      expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Coding");
    });

    it("hides the badge when an explicit workflow assignment cannot be resolved", async () => {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValueOnce({
        ...workflowPayload,
        taskWorkflowIds: { "FN-stale": "wf-deleted" },
      });

      renderDetail(makeTask({ id: "FN-stale", column: "todo", title: "Stale workflow task" }));

      await waitFor(() => expect(dashboardApi.fetchBoardWorkflows).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("task-detail-workflow-badge")).toBeNull();
    });

    it("updates the badge when a mounted task detail switches tasks", async () => {
      vi.mocked(dashboardApi.fetchBoardWorkflows)
        .mockResolvedValueOnce(workflowPayload)
        .mockResolvedValueOnce(workflowPayload);
      const props = {
        initialTab: "details" as const,
        task: makeTask({ id: "FN-101", column: "todo", title: "Docs task" }),

        onDeleteTask: noopDelete,
        onMergeTask: noopMerge,
        onOpenDetail: noopOpenDetail,
        addToast: noop,
      };

      const { rerender } = render(<TaskDetailContent {...props} embedded onRequestClose={noop} />);
      expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Docs");

      rerender(<TaskDetailContent {...props} task={makeTask({ id: "FN-default", column: "in-review", title: "Coding task" })} embedded onRequestClose={noop} />);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      await waitFor(() => expect(screen.getByTestId("task-detail-workflow-badge")).toHaveTextContent("Coding"));
    });

    it("clears the previous workflow badge while a mounted task switch reloads metadata", async () => {
      let resolveNextPayload: (payload: typeof workflowPayload) => void = () => undefined;
      vi.mocked(dashboardApi.fetchBoardWorkflows)
        .mockResolvedValueOnce(workflowPayload)
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveNextPayload = resolve;
        }));
      const props = {
        initialTab: "details" as const,
        task: makeTask({ id: "FN-101", column: "todo", title: "Docs task" }),

        onDeleteTask: noopDelete,
        onMergeTask: noopMerge,
        onOpenDetail: noopOpenDetail,
        addToast: noop,
      };

      const { rerender } = render(<TaskDetailContent {...props} embedded onRequestClose={noop} />);
      expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Docs");

      rerender(<TaskDetailContent {...props} task={makeTask({ id: "FN-default", column: "in-review", title: "Coding task" })} embedded onRequestClose={noop} />);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      await waitFor(() => expect(dashboardApi.fetchBoardWorkflows).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId("task-detail-workflow-badge")).toBeNull();

      await act(async () => {
        resolveNextPayload(workflowPayload);
      });
      expect(await screen.findByTestId("task-detail-workflow-badge")).toHaveTextContent("Coding");
    });

    it("hides the badge without workflow metadata and leaves no empty shell", async () => {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValueOnce({
        flagEnabled: false,
        defaultWorkflowId: "",
        workflows: [],
        taskWorkflowIds: {},
      });

      const { container } = renderDetail();

      await waitFor(() => expect(dashboardApi.fetchBoardWorkflows).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("task-detail-workflow-badge")).toBeNull();
      expect(document.querySelector(".detail-workflow-badge")).toBeNull();
    });

    it("renders the canonical badge beside the Updated timestamp in the mobile back-header variant", async () => {
      vi.mocked(dashboardApi.fetchBoardWorkflows).mockResolvedValueOnce(workflowPayload);

      const { container } = render(
        <TaskDetailModal
          initialTab="details"
          mobileHeaderMode="back"
          task={makeTask({ id: "FN-101", column: "todo", title: "Docs task" })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const badge = await screen.findByTestId("task-detail-workflow-badge");
      const timestamps = document.querySelector(".detail-timestamps");
      const updatedLabel = screen.getByText("Updated").closest(".detail-timestamp-item");
      expect(badge).toHaveTextContent("Docs");
      expect(badge.parentElement).toBe(timestamps);
      expect(updatedLabel?.nextElementSibling).toBe(badge);
      expect(screen.getAllByTestId("task-detail-workflow-badge")).toHaveLength(1);
      expect(screen.queryByTestId("task-detail-workflow-badge-mobile")).toBeNull();
      expect(document.querySelector(".detail-title-row .detail-workflow-badge")).toBeNull();
      expect(screen.getByRole("button", { name: "Back to task list" })).toBeInTheDocument();
    });
  });

  it("keeps refreshed prompt and summary file links interactive in code wrappers", async () => {
    const openFile = vi.fn();
    const initialDetail = makeTask({
      column: "done",
      summary: "See `packages/dashboard/app/App.tsx:25:3` for context.",
      prompt: "# Prompt\n\nInspect `packages/dashboard/app/App.tsx:11`.",
    });
    vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValue({
      id: initialDetail.id,
      prompt: "# Prompt\n\nInspect `packages/dashboard/app/App.tsx:12`.",
    });

    render(
      <FileBrowserProvider openFile={openFile}>
        <TaskDetailModal
          initialTab="definition"
          task={initialDetail}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />
      </FileBrowserProvider>,
    );

    /*
    FNXC:DashboardTests 2026-08-05-04:05:
    Definition refresh updates only its prompt tree. Query after the narrow response settles so
    this integration test clicks the live prompt link, then assert the separately rendered
    completed-summary surface retains the same FileBrowser contract.
    */
    await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledWith("FN-099", undefined));
    const promptLink = await screen.findByRole("button", { name: "packages/dashboard/app/App.tsx:12" });
    expect(screen.queryByRole("button", { name: "packages/dashboard/app/App.tsx:11" })).toBeNull();
    expect(promptLink.closest("code")?.querySelector("button.file-path-link")).toBe(promptLink);
    await userEvent.click(promptLink);

    await userEvent.click(screen.getByRole("button", { name: "Summary" }));
    const summaryLink = screen.getByRole("button", { name: "packages/dashboard/app/App.tsx:25:3" });
    expect(summaryLink.closest("code")?.querySelector("button.file-path-link")).toBe(summaryLink);
    await userEvent.click(summaryLink);

    expect(openFile).toHaveBeenNthCalledWith(1, "packages/dashboard/app/App.tsx", { line: 12, col: undefined });
    expect(openFile).toHaveBeenNthCalledWith(2, "packages/dashboard/app/App.tsx", { line: 25, col: 3 });
  });

  /*
  FNXC:Markdown 2026-06-23-03:30:
  The task DESCRIPTION (spec/prompt) + SUMMARY now share the markdown pipeline's
  rehype-raw -> rehype-sanitize chain, so embedded raw HTML renders as real
  elements (not literal text), HTML comments drop, <script> is stripped, and
  ```mermaid fences render diagrams — while keeping `.markdown-body` styling.
  */
  it("renders raw HTML and mermaid in the description while stripping unsafe content", async () => {
    const prompt = [
      "# Prompt",
      "",
      "<details><summary>Disclosure title</summary>Hidden detail body.</details>",
      "",
      "<!-- secret comment -->",
      "",
      "<script>window.__pwned = true;</script>",
      "",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
    ].join("\n");

    const { container } = render(
      <FileBrowserProvider openFile={vi.fn()}>
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ prompt })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />
      </FileBrowserProvider>,
    );

    // Raw <details>/<summary> renders as a real disclosure element.
    const details = document.querySelector(".markdown-body details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toBe("Disclosure title");
    expect(details?.textContent).toContain("Hidden detail body.");

    // HTML comment is dropped, never shown as literal text.
    expect(container.textContent).not.toContain("secret comment");

    // <script> is stripped by sanitize: not rendered and never executed.
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();

    // ```mermaid fence renders the diagram container (lazy MermaidDiagram).
    const diagram = await screen.findByTestId("task-detail-mermaid-diagram");
    expect(diagram).not.toBeNull();
  });

  describe("provenance display", () => {
    it.each([
      ["dashboard_ui", undefined, "Created via Dashboard"],
      ["agent_heartbeat", "agent-123", "Created by"],
    ] as const)("renders provenance text for %s", (sourceType, sourceAgentId, expectedText) => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceType, sourceAgentId })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText(new RegExp(expectedText))).toBeInTheDocument();
      if (sourceType === "agent_heartbeat" && sourceAgentId) {
        expect(screen.getByRole("button", { name: sourceAgentId })).toBeInTheDocument();
      }
    });

    // FNXC:TaskDetailModal 2026-08-15-00:00 (slow-test trim): refinement and API-created
    // parent-link cases shared one body; converted to it.each with both cases kept.
    it.each([
      ["refinement provenance", "task_refine", "FN-001", /Created via Refinement/],
      ["API-created planning tasks", "api", "FN-PLANNER", /Created via API/],
    ] as const)("renders parent task link for %s", async (_label, sourceType, parentId, expectedText) => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceType, sourceParentTaskId: parentId })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText(expectedText)).toBeInTheDocument();
      const link = screen.getByRole("button", { name: parentId });
      expect(link).toBeInTheDocument();
      await userEvent.click(link);
      await waitFor(() => {
        expect(noopOpenDetail).toHaveBeenCalled();
      });
    });

    it.each([
      ["desktop", undefined],
      ["compact/mobile", "back"],
    ] as const)("links only the GitHub Import label to the source issue on %s markup", (_layout, mobileHeaderMode) => {
      const { container } = render(
        <TaskDetailModal
          initialTab="details"
          mobileHeaderMode={mobileHeaderMode}
          task={makeTask({
            sourceType: "github_import",
            sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42" },
          })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const issueLink = screen.getByRole("link", { name: "GitHub Import" });
      const provenance = issueLink.closest(".detail-provenance");
      expect(provenance).toHaveTextContent("Created via GitHub Import");
      expect(provenance?.textContent).not.toMatch(/[()]/);
      expect(provenance?.querySelectorAll("a")).toHaveLength(1);
      expect(document.querySelector(".detail-provenance-context")).toBeNull();

      expect(issueLink).toHaveAttribute("href", "https://github.com/owner/repo/issues/42");
      expect(issueLink).toHaveAttribute("target", "_blank");
      expect(issueLink).toHaveAttribute("rel", "noopener noreferrer");
      expect(issueLink).not.toHaveAttribute("title");
    });

    it("keeps GitHub Import as the sole link for a populated nonstandard source URL", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            sourceType: "github_import",
            sourceMetadata: { issueUrl: "https://example.com/something" },
          })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const issueLink = screen.getByRole("link", { name: "GitHub Import" });
      const provenance = issueLink.closest(".detail-provenance");
      expect(issueLink).toHaveAttribute("href", "https://example.com/something");
      expect(provenance?.querySelectorAll("a")).toHaveLength(1);
      expect(provenance?.textContent).toBe("Created via GitHub Import");
      expect(screen.queryByText("Open issue")).toBeNull();
    });

    it("renders a URL-absent GitHub import as plain text without a link shell", () => {
      const { container, rerender } = render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceType: "github_import", sourceMetadata: undefined })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const assertPlainFallback = () => {
        const provenance = screen.getByText("Created via GitHub Import").closest(".detail-provenance");
        expect(provenance?.textContent).toBe("Created via GitHub Import");
        expect(provenance?.querySelector("a")).toBeNull();
        expect(document.querySelector(".detail-provenance-context")).toBeNull();
      };

      assertPlainFallback();
      rerender(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceType: "github_import", sourceMetadata: {} })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      assertPlainFallback();
    });

    it("renders finding label for research provenance", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            sourceType: "research",
            sourceMetadata: {
              runId: "RR-123",
              findingLabel: "Pricing pressure in EU segment",
            },
          })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText(/Created via Research/).closest(".detail-provenance")).toHaveTextContent(
        "Created via Research (Pricing pressure in EU segment)",
      );
    });

    it("falls back to run id for research provenance context", () => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            sourceType: "research",
            sourceMetadata: { runId: "RR-456" },
          })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText(/Created via Research/).closest(".detail-provenance")).toHaveTextContent(
        "Created via Research (RR-456)",
      );
    });

    it.each(["unknown", undefined] as const)("omits provenance for %s source", (sourceType) => {
      render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceType })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.queryByText(/Created via/)).not.toBeInTheDocument();
    });

    /**
     * FNXC:TaskRevert 2026-07-04-00:00:
     * FN-7555 bidirectional undo→source affordance coverage. Forward: an AI-undo
     * task (`sourceMetadata.revertOf` set by `createAiUndoTask`) shows a clickable
     * "Created to undo <id>" link. Reverse: a source task shows an "Undo task: <id>"
     * link only when an OPEN undo task referencing it exists in the loaded `tasks`
     * list — mirroring `TaskStore.findOpenRevertTaskForSource`'s open-only semantics
     * (done or soft-deleted undo tasks must not surface as an active link).
     */
    describe("undo/revert provenance", () => {
      it("renders a clickable 'Created to undo <id>' link for an AI-undo task", async () => {
        render(
          <TaskDetailModal
            initialTab="details"
            task={makeTask({ id: "FN-200", sourceType: "recovery", sourceMetadata: { revertOf: "FN-100" } })}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        expect(screen.getByText(/Created to undo/)).toBeInTheDocument();
        const link = screen.getByRole("button", { name: "FN-100" });
        expect(link).toBeInTheDocument();
        await userEvent.click(link);
        await waitFor(() => {
          expect(noopOpenDetail).toHaveBeenCalled();
        });
      });

      it("renders nothing for the forward link when sourceMetadata.revertOf is absent", () => {
        render(
          <TaskDetailModal
            initialTab="details"
            task={makeTask({ id: "FN-200", sourceType: "recovery", sourceMetadata: {} })}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        expect(screen.queryByText(/Created to undo/)).not.toBeInTheDocument();
      });

      it("does not throw and renders nothing for malformed revertOf metadata", () => {
        render(
          <TaskDetailModal
            initialTab="details"
            task={makeTask({ id: "FN-200", sourceMetadata: { revertOf: 999 as any } })}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        expect(screen.queryByText(/Created to undo/)).not.toBeInTheDocument();
      });

      it("renders an 'Undo task: <id>' link when an OPEN undo task references this source task", async () => {
        const sourceTask = makeTask({ id: "FN-100", column: "done" });
        const undoTask = makeTask({ id: "FN-201", column: "todo", sourceType: "recovery", sourceMetadata: { revertOf: "FN-100" }, createdAt: "2026-07-04T00:00:00.000Z" });

        render(
          <TaskDetailModal
            initialTab="details"
            task={sourceTask}
            tasks={[sourceTask, undoTask]}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        const link = screen.getByRole("button", { name: "FN-201" });
        expect(link).toBeInTheDocument();
        await userEvent.click(link);
        await waitFor(() => {
          expect(noopOpenDetail).toHaveBeenCalled();
        });
      });

      it("renders no reverse link when the only undo task for this source is done (open-only invariant)", () => {
        const sourceTask = makeTask({ id: "FN-100", column: "done" });
        const doneUndoTask = makeTask({ id: "FN-202", column: "done", sourceType: "recovery", sourceMetadata: { revertOf: "FN-100" } });

        render(
          <TaskDetailModal
            initialTab="details"
            task={sourceTask}
            tasks={[sourceTask, doneUndoTask]}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        expect(screen.queryByRole("button", { name: "FN-202" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "FN-203" })).not.toBeInTheDocument();
      });

      it("renders no reverse link and no empty shell when no undo task exists for this source", () => {
        const sourceTask = makeTask({ id: "FN-100", column: "done" });

        const { container } = render(
          <TaskDetailModal
            initialTab="details"
            task={sourceTask}
            tasks={[sourceTask]}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        expect(document.querySelector(".detail-undo-task-row")).toBeNull();
      });

      it("picks the most recently created open undo task when multiple exist", async () => {
        const sourceTask = makeTask({ id: "FN-100", column: "done" });
        const olderUndo = makeTask({ id: "FN-204", column: "todo", sourceMetadata: { revertOf: "FN-100" }, createdAt: "2026-07-01T00:00:00.000Z" });
        const newerUndo = makeTask({ id: "FN-205", column: "todo", sourceMetadata: { revertOf: "FN-100" }, createdAt: "2026-07-03T00:00:00.000Z" });

        render(
          <TaskDetailModal
            initialTab="details"
            task={sourceTask}
            tasks={[sourceTask, olderUndo, newerUndo]}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        expect(screen.getByRole("button", { name: "FN-205" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "FN-204" })).not.toBeInTheDocument();
      });
    });

    it("FN-3755 renders provenance before created-updated timestamps", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceType: "dashboard_ui" })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const provenance = screen.getByText("Created via Dashboard").closest(".detail-provenance");
      const timestamps = document.querySelector(".detail-timestamps");

      expect(provenance).toBeTruthy();
      expect(timestamps).toBeTruthy();
      expect(provenance?.compareDocumentPosition(timestamps as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("groups provenance and timestamps in the Details metadata section without inline controls", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({ sourceType: "task_refine", sourceParentTaskId: "FN-001" })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const metadataSection = document.querySelector(".detail-section--task-metadata");
      const provenance = screen.getByText(/Created via Refinement/).closest(".detail-provenance");
      const timestamps = document.querySelector(".detail-timestamps");

      expect(metadataSection).toBeTruthy();
      expect(document.querySelector(".detail-meta-inline-controls")).toBeNull();
      expect(provenance?.parentElement).toBe(metadataSection);
      expect(timestamps?.parentElement).toBe(metadataSection);
    });

    it("keeps the optional PR link with provenance and timestamps in Details metadata", () => {
      const { container } = render(
        <TaskDetailModal
          initialTab="details"
          task={makeTask({
            sourceType: "dashboard_ui",
            prInfo: { number: 42, url: "https://github.com/owner/repo/pull/42" },
          })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      const metadataSection = document.querySelector(".detail-section--task-metadata");
      const provenance = screen.getByText("Created via Dashboard").closest(".detail-provenance");
      const prRow = document.querySelector(".detail-pr-link-row");
      const timestamps = document.querySelector(".detail-timestamps");

      expect(metadataSection).toBeTruthy();
      expect(document.querySelector(".detail-meta-inline-controls")).toBeNull();
      expect(provenance?.parentElement).toBe(metadataSection);
      expect(prRow?.parentElement).toBe(metadataSection);
      expect(timestamps?.parentElement).toBe(metadataSection);
    });

    describe("compact timestamp metadata", () => {
      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-11T12:00:00.000Z"));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("renders compact relative timestamps for recent tasks", () => {
        render(
          <TaskDetailModal
            initialTab="details"
            task={makeTask({
              sourceType: "dashboard_ui",
              createdAt: "2026-05-09T12:00:00.000Z",
              updatedAt: "2026-05-11T09:00:00.000Z",
            })}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        const timestamps = screen.getByLabelText("Task timestamps");
        expect(timestamps).toHaveTextContent("Created 2d ago");
        expect(timestamps).toHaveTextContent("Updated 3h ago");
        expect(getComputedStyle(timestamps).flexWrap).toBe("nowrap");
        expect(timestamps.querySelector(".detail-timestamp-separator")).toBeTruthy();

        const times = timestamps.querySelectorAll("time");
        expect(times[0]?.getAttribute("dateTime")).toBe("2026-05-09T12:00:00.000Z");
        expect(times[1]?.getAttribute("dateTime")).toBe("2026-05-11T09:00:00.000Z");
      });

      // FNXC:TaskDetailModal 2026-08-15-00:00 (slow-test trim): the standalone
      // "short calendar date for older timestamps" case was one more bucket permutation of the
      // same formatter; folded into the bucket/edge-case test below as an extra rerender.
      it("preserves byte-identical timestamp buckets and edge cases", () => {
        const { rerender } = render(
          <TaskDetailModal
            initialTab="details"
            task={makeTask({
              sourceType: "dashboard_ui",
              createdAt: "2026-05-11T11:59:30.000Z",
              updatedAt: "2026-05-11T11:55:00.000Z",
            })}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        let timestamps = screen.getByLabelText("Task timestamps");
        expect(timestamps).toHaveTextContent("Created just now");
        expect(timestamps).toHaveTextContent("Updated 5m ago");

        rerender(
          <TaskDetailModal
            initialTab="details"
            task={makeTask({
              sourceType: "dashboard_ui",
              createdAt: "not-a-date",
              updatedAt: "2026-05-11T12:00:01.000Z",
            })}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        timestamps = screen.getByLabelText("Task timestamps");
        expect(timestamps).toHaveTextContent("Created Invalid Date");
        expect(timestamps).toHaveTextContent("Updated just now");

        rerender(
          <TaskDetailModal
            initialTab="details"
            task={makeTask({
              sourceType: "dashboard_ui",
              createdAt: "2026-05-01T12:00:00.000Z",
              updatedAt: "2026-05-02T12:00:00.000Z",
            })}
            onClose={noop}

            onDeleteTask={noopDelete}
            onMergeTask={noopMerge}
            onOpenDetail={noopOpenDetail}
            addToast={noop}
          />,
        );

        timestamps = screen.getByLabelText("Task timestamps");
        expect(timestamps).toHaveTextContent("Created May 1");
        expect(timestamps).toHaveTextContent("Updated May 2");
      });
    });
  });

  it("shows active file scope overlap blocker in Dependencies section", () => {
    render(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: "FN-OVER" })}
        tasks={[
          makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: "FN-OVER" }),
          makeTask({ id: "FN-OVER", column: "in-progress" }),
        ]}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("File scope overlap blocker: FN-OVER")).toBeInTheDocument();
    expect(screen.queryByText("File scope overlap blocker: FN-OVER (stale)")).toBeNull();
  });

  it("keeps clear overlap blocker button when slim live task omits overlapBlockedBy", () => {
    const { rerender } = render(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: "FN-OVER" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();

    rerender(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: undefined })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("repairs overlap blocker when clicking Clear", async () => {
    vi.mocked(dashboardApi.repairOverlapBlocker).mockResolvedValueOnce({
      taskId: "FN-T",
      dryRun: false,
      repaired: true,
      statusCleared: true,
      previousOverlapBlockedBy: "FN-OVER",
      reason: "repaired",
      message: "Cleared stale overlap blocker FN-OVER",
      task: makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: undefined, status: undefined }),
    });

    render(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: "FN-OVER", status: "queued" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(dashboardApi.repairOverlapBlocker).toHaveBeenCalledWith(
        "FN-T",
        { reason: "dashboard-clear-overlap-blocker" },
        undefined,
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    });
  });

  it("applies rerouted overlap blocker returned by repair API", async () => {
    vi.mocked(dashboardApi.repairOverlapBlocker).mockResolvedValueOnce({
      taskId: "FN-T",
      dryRun: false,
      repaired: true,
      statusCleared: false,
      previousOverlapBlockedBy: "FN-OLD",
      currentOverlapBlockedBy: "FN-NEW",
      reason: "rerouted-to-current-overlap",
      message: "Stale overlap blocker FN-OLD rerouted to FN-NEW",
      task: makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: "FN-NEW", status: "queued" }),
    });

    render(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: "FN-OLD", status: "queued" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(screen.getByText("File scope overlap blocker: FN-NEW (stale)")).toBeInTheDocument();
    });
  });

  it("shows toast and preserves overlap blocker when repair fails", async () => {
    const addToast = vi.fn();
    vi.mocked(dashboardApi.repairOverlapBlocker).mockRejectedValueOnce(new Error("boom"));

    render(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-T", column: "todo", overlapBlockedBy: "FN-OVER", status: "queued" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={addToast}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("boom", "error");
    });
    expect(screen.getByText("File scope overlap blocker: FN-OVER (stale)")).toBeInTheDocument();
  });

  it("counts the overlap blockedBy summary using the board's OWN lane names", () => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-23:35:
    The case below renamed and nothing else. Without resolved traits the count is taken against the
    literal `todo`, which no card is in, so this line read "blocking 0 todo task(s)" while two cards
    were in fact blocked. The dependent LIST stayed correct throughout (core builds it without
    consulting lanes), which is what made the wrong number easy to miss.
    */
    const tasks = [
      makeTask({ id: "FN-B", column: "building" }),
      makeTask({ id: "FN-1", column: "drafting", blockedBy: "FN-B" }),
      makeTask({ id: "FN-2", column: "drafting", blockedBy: "FN-B" }),
    ];
    const columnFlagsByTaskId = new Map(tasks.map((task) => [
      task.id,
      task.column === "building" ? { countsTowardWip: true } : { hold: true },
    ]));

    render(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-B", column: "building" })}
        tasks={tasks}
        columnFlagsByTaskId={columnFlagsByTaskId}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("FN-B is blocking 2 todo task(s) via blockedBy overlap")).toBeInTheDocument();
  });

  it("shows overlap blockedBy summary in Blocking section", () => {
    render(
      <TaskDetailModal
        initialTab="dependencies"
        task={makeTask({ id: "FN-B", column: "in-progress" })}
        tasks={[
          makeTask({ id: "FN-B", column: "in-progress" }),
          makeTask({ id: "FN-1", column: "todo", blockedBy: "FN-B" }),
          makeTask({ id: "FN-2", column: "todo", blockedBy: "FN-B" }),
        ]}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("FN-B is blocking 2 todo task(s) via blockedBy overlap")).toBeInTheDocument();
  });

  it("renders modal wrapper structure and default close control", () => {
    const { container } = render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask()}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    /*
    FNXC:TaskDetailModal 2026-07-30-22:50 (#2895 review — greptile, "obsolete modal overlay selector"):
    THE SHELL IS `FloatingWindow`, NOT A `.modal-overlay`.

    `TaskDetailModal` renders `<FloatingWindow modal>`, whose overlay class is
    `floating-window-overlay--modal`. The only `.modal-overlay` left in this component is the refine
    SUB-overlay at ~line 6801, which this case does not open — so the assertion was querying a class
    that is never in the tree for the default render and failed outright.

    Asserting the modal-ness (`--modal`), not just the overlay: a non-modal FloatingWindow renders the
    same base class, so the bare selector would keep passing if the `modal` prop were dropped.
    */
    expect(document.querySelector(".floating-window-overlay--modal")).toBeTruthy();
    expect(document.querySelector(".modal.modal-lg.task-detail-modal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to task list" })).toBeNull();
  });

  it("renders mobile back control variant when requested", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask()}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        mobileHeaderMode="back"
      />,
    );

    expect(screen.getByRole("button", { name: "Back to task list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("omits close control in embedded mode while rendering shared content", () => {
    const { container } = render(
      <TaskDetailContent
        task={makeTask()}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        embedded
      />,
    );

    expect(document.querySelector(".task-detail-content--embedded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();
  });

  it("renders header close control for embedded floating task details", () => {
    const onRequestClose = vi.fn();
    render(
      <TaskDetailContent
        task={makeTask()}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        embedded
        onRequestClose={onRequestClose}
      />,
    );

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toHaveClass("task-detail-floating-close");
    fireEvent.click(closeButton);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  function expectNoBranchReattachmentAffordance(container: HTMLElement): void {
    // FN-6983: Task Detail must not ask users to manually reattach branches; self-healing owns recovery.
    expect(screen.queryByText(/Branch needs reattachment/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Branch binding lost/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't currently attached to a fusion branch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reattached branch/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reattach branch/i })).not.toBeInTheDocument();
    expect(document.querySelector(".rebind-banner")).toBeNull();
    expect(document.querySelector(".rebind-banner-actions")).toBeNull();
    expect(document.querySelector(".rebind-banner-result")).toBeNull();
  }

  function renderTaskDetail(task: ReturnType<typeof makeTask>, mobileHeaderMode?: "back") {
    return render(
      <TaskDetailModal
        initialTab="definition"
        task={task}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        mobileHeaderMode={mobileHeaderMode}
      />,
    );
  }

  describe("branch reattachment affordance absence", () => {
    it.each([
      ["null branch and worktree", makeTask({ column: "in-review", branch: null, worktree: null })],
      ["undefined branch with missing worktree", makeTask({ column: "in-review", branch: undefined, worktree: null })],
      ["populated branch control", makeTask({ column: "in-review", branch: "fusion/fn-099", worktree: "/tmp/fn-099" })],
      ["non-in-review missing branch", makeTask({ column: "todo", branch: null, worktree: null })],
    ] as const)("renders no reattachment banner for %s", (_label, task) => {
      const { container } = renderTaskDetail(task);

      expectNoBranchReattachmentAffordance(container);
    });

    it("renders no reattachment banner for workspace in-review tasks with no singular branch", () => {
      const task = makeTask({
        column: "in-review",
        worktree: null,
        workspaceWorktrees: {
          "repo-a": { worktreePath: "/tmp/fn-099/repo-a", branch: "fusion/fn-099", baseCommitSha: "abc123" },
          "repo-b": { worktreePath: "/tmp/fn-099/repo-b", branch: "fusion/fn-099" },
        },
      });
      delete (task as { branch?: string | null }).branch;

      const { container } = renderTaskDetail(task);

      expectNoBranchReattachmentAffordance(container);
    });

    it("keeps the removed mobile rebind action shell absent in narrow task detail rendering", () => {
      const { container } = renderTaskDetail(makeTask({ column: "in-review", branch: null, worktree: null }), "back");

      expect(screen.getByRole("button", { name: "Back to task list" })).toBeInTheDocument();
      expectNoBranchReattachmentAffordance(container);
    });

    it("renders no reattachment banner from embedded TaskDetailContent", () => {
      const { container } = render(
        <TaskDetailContent
          task={makeTask({ column: "in-review", branch: null, worktree: null })}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
          embedded
        />,
      );

      expectNoBranchReattachmentAffordance(container);
    });
  });

  // FNXC:TaskDetailModal 2026-08-15-00:00 (slow-test trim): the detail-body and
  // agent-log-viewer scrollbar rules were two copies of the same structural CSS-string
  // pattern; merged into one case with identical assertions.
  it("styles detail-body and agent log viewer scrollbar rules", () => {
    const css = readDashboardStylesSource();

    expectBaseRule(css, ".detail-body", "scrollbar-color: var(--border) transparent;");
    expectBaseRule(css, ".detail-body", "scrollbar-width: thin;");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar", "width: 6px;");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar-track", "background: transparent;");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar-thumb", "background: var(--border);");
    expectBaseRule(css, ".detail-body::-webkit-scrollbar-thumb:hover", "background: var(--text-muted);");

    expectBaseRule(css, ".agent-log-viewer", "overflow: hidden;");
    expectBaseRule(css, ".agent-log-viewer-scroll", "scrollbar-color: var(--border) transparent;");
    expectBaseRule(css, ".agent-log-viewer-scroll", "scrollbar-width: thin;");
    expectBaseRule(css, ".agent-log-viewer-scroll::-webkit-scrollbar", "width: 6px;");
    expectBaseRule(css, ".agent-log-viewer-scroll::-webkit-scrollbar-thumb", "background: var(--border);");
    expectBaseRule(css, ".agent-log-model-header", "background: var(--bg-tertiary);");
  });

  // FNXC:TaskDetailModal 2026-08-15-00:00 (slow-test trim): the markdown-body class shape,
  // heading stripping, and PROMPT.md-heading absence cases were three separate renders of the
  // same prompt-bearing props; merged into one render with all assertions intact.
  it("strips the leading heading and renders prompt markdown without detail-prompt class or PROMPT.md heading", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ prompt: "# Hello\n\nSome **bold** text" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const markdownDiv = document.querySelector(".markdown-body");
    expect(markdownDiv).toBeTruthy();
    expect(markdownDiv!.classList.contains("detail-prompt")).toBe(false);
    // The leading # heading should be stripped (modal has its own header)
    expect(document.querySelector(".markdown-body h1")).toBeNull();
    expect(document.querySelector("strong")?.textContent).toBe("bold");
    expect(screen.queryByText("PROMPT.md")).toBeNull();
  });

  it("renders (no prompt) with detail-prompt class when prompt is absent", () => {
    const { container } = render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ prompt: undefined })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const fallback = screen.getByText("(no prompt)");
    expect(fallback).toBeTruthy();
    expect(fallback.classList.contains("detail-prompt")).toBe(true);
    expect(fallback.classList.contains("markdown-body")).toBe(false);
  });

  it("renders Review and Comments tabs", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask()}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Comments")).toBeTruthy();
  });

  it("shows non-PR review shell message in Review tab", async () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ reviewState: { source: "reviewer-agent", items: [], addressing: [] } })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("No reviewer feedback yet — this task has not produced reviewer-agent feedback in direct mode.")).toBeTruthy();
  });

  it("keeps Comments tab available after Review refresh", async () => {
    vi.mocked(dashboardApi.fetchTaskReview).mockResolvedValueOnce({
      reviewState: {
        source: "pull-request",
        summary: {
          reviewDecision: "REVIEW_REQUIRED",
          reviewers: [],
          blockingReasons: [],
          checks: [],
        },
        items: [],
        addressing: [],
      },
      automationStatus: null,
      emptyMessage: null,
    });
    vi.mocked(dashboardApi.refreshTaskReview).mockResolvedValueOnce({
      reviewState: {
        source: "pull-request",
        summary: {
          reviewDecision: "APPROVED",
          reviewers: [{ login: "octocat", state: "APPROVED" }],
          blockingReasons: [],
          checks: [],
        },
        items: [],
        addressing: [],
        refreshStatus: "ready",
      },
      automationStatus: null,
    });

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ reviewState: { source: "pull-request", summary: { reviewDecision: "REVIEW_REQUIRED", reviewers: [], blockingReasons: [], checks: [] }, items: [], addressing: [] } })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect((await screen.findAllByText("APPROVED")).length).toBeGreaterThan(0);

    const commentsTab = screen.getByRole("button", { name: "Comments" });
    expect(commentsTab).toBeInTheDocument();
    fireEvent.click(commentsTab);
    expect(screen.getByRole("heading", { name: "Comments" })).toBeInTheDocument();
  });

  it("shows PR review decision details in Review tab", async () => {
    vi.mocked(dashboardApi.fetchTaskReview).mockResolvedValueOnce({
      reviewState: {
        source: "pull-request",
        summary: {
          reviewDecision: "CHANGES_REQUESTED",
          reviewers: [{ login: "octocat", state: "CHANGES_REQUESTED" }],
          blockingReasons: ["changes requested review is active"],
          checks: [],
        },
        items: [],
        addressing: [],
      },
      automationStatus: null,
      emptyMessage: null,
    });
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ reviewState: { source: "pull-request", summary: { reviewDecision: "CHANGES_REQUESTED", reviewers: [{ login: "octocat", state: "CHANGES_REQUESTED" }], blockingReasons: ["changes requested review is active"], checks: [] }, items: [], addressing: [] } })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect((await screen.findAllByText("CHANGES_REQUESTED")).length).toBeGreaterThan(0);
    expect(screen.getByText(/No review items yet\./i)).toBeTruthy();
  });

  describe("footer quick actions", () => {
    it("renders Priority and Fast as labeled Actions menu items with selected state", async () => {
      render(<TaskDetailModal initialTab="details" task={makeTask({ column: "todo", priority: "high", executionMode: "fast" })} onClose={noop} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} addToast={noop} />);
      fireEvent.click(screen.getByRole("button", { name: "Actions" }));

      const priority = screen.getByTestId("detail-priority-option-high");
      const fast = screen.getByTestId("detail-execution-mode-toggle");
      expect(priority).toHaveTextContent("High");
      expect(priority).toHaveAttribute("aria-pressed", "true");
      expect(fast).toHaveAccessibleName("Execution mode: fast");
      expect(fast).toHaveAttribute("aria-pressed", "true");
    });

    it("keeps Attach, GitHub, Oversight, Priority, and Fast in Quick Add order", async () => {
      render(<TaskDetailModal initialTab="details" task={makeTask({ column: "todo", plannerOversightLevel: "observe" })} onClose={noop} onDeleteTask={noopDelete} onMergeTask={noopMerge} onOpenDetail={noopOpenDetail} addToast={noop} />);
      fireEvent.click(screen.getByRole("button", { name: "Actions" }));

      const orderedItems = [
        screen.getByTestId("detail-inline-attach"),
        screen.getByTestId("detail-inline-github-toggle"),
        screen.getByTestId("detail-actions-oversight-heading"),
        screen.getByTestId("detail-actions-priority-heading"),
        screen.getByTestId("detail-execution-mode-toggle"),
      ];
      for (let index = 1; index < orderedItems.length; index += 1) {
        expect(orderedItems[index - 1]?.compareDocumentPosition(orderedItems[index] as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(document.querySelector(".detail-meta-inline-controls")).toBeNull();
    });

    it("removes bespoke toolbar SVG sizing rules", () => {
      const css = readDashboardStylesSource();
      expect(css).not.toMatch(/\.detail-oversight-menu-trigger svg\s*\{[^}]*width:\s*1em/);
      expect(css).not.toMatch(/\.detail-execution-mode-toggle svg\s*\{[^}]*width:\s*1em/);
    });
  });

  it("appends daemon token query to attachment href/src URLs for direct browser loads", () => {
    localStorage.setItem("fn.authToken", "daemon-token");

    render(
      <TaskDetailModal
        initialTab="attachments"
        task={makeTask({
          attachments: [
            {
              filename: "screenshot.png",
              originalName: "Screenshot",
              mimeType: "image/png",
              size: 1024,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const attachmentLink = screen.getByRole("link", { name: "Screenshot" });
    const attachmentImage = screen.getByAltText("Screenshot");

    expect(attachmentLink.getAttribute("href")).toBe(
      "/api/tasks/FN-099/attachments/screenshot.png?fn_token=daemon-token",
    );
    expect(attachmentImage.getAttribute("src")).toBe(
      "/api/tasks/FN-099/attachments/screenshot.png?fn_token=daemon-token",
    );
  });

  it("leaves attachment href/src URLs unchanged when no daemon token is present", () => {
    render(
      <TaskDetailModal
        initialTab="attachments"
        task={makeTask({
          attachments: [
            {
              filename: "screenshot.png",
              originalName: "Screenshot",
              mimeType: "image/png",
              size: 1024,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const attachmentLink = screen.getByRole("link", { name: "Screenshot" });
    const attachmentImage = screen.getByAltText("Screenshot");

    expect(attachmentLink.getAttribute("href")).toBe("/api/tasks/FN-099/attachments/screenshot.png");
    expect(attachmentImage.getAttribute("src")).toBe("/api/tasks/FN-099/attachments/screenshot.png");
  });

  it("renders Retry button when task status is 'failed' (in Actions dropdown)", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ status: "failed" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );

    // Open Actions dropdown to see Retry
    const actionsBtn = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(actionsBtn);

    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeTruthy();
  });

  it("renders Retry for a live task even when its status is not failed", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ status: "executing" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );

    const actionsBtn = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(actionsBtn);
    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeInTheDocument();
  });

  it("does NOT render Retry button when onRetryTask is not provided", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ status: "failed" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("shows the failure alert and Retry actions while automatic recovery is pending", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          status: "failed",
          error: "Transient provider error",
          recoveryRetryCount: 1,
          nextRecoveryAt: new Date(Date.now() + 60_000).toISOString(),
        })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Transient provider error");
    expect(screen.getByText("Automatic recovery is pending. You can Retry now to restart this stage.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry with a different model/node" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeInTheDocument();
  });

  describe("retry action uniqueness for in-review failed tasks", () => {
    // FNXC:TaskDetailModal 2026-08-15-00:00 (slow-test trim): the failed and stuck-killed
    // in-review uniqueness cases shared one body; converted to it.each with both statuses kept.
    it.each(["failed", "stuck-killed"] as const)(
      "shows exactly one Retry button when task is in-review AND %s (in Actions dropdown)",
      (status) => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review", status })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={noopRetry}
          addToast={noop}
        />,
      );

      // Open Actions dropdown and check for exactly one Retry
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      fireEvent.click(actionsBtn);

      const retryButtons = screen.getAllByRole("menuitem", { name: "Retry" });
      expect(retryButtons).toHaveLength(1);
    });

    it("shows Retry for a stranded planning triage task", () => {
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "triage", status: "planning", stuckKillCount: 6 })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={noopRetry}
          addToast={noop}
        />,
      );

      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      fireEvent.click(actionsBtn);

      const retryButtons = screen.getAllByRole("menuitem", { name: "Retry" });
      expect(retryButtons).toHaveLength(1);
    });

    it("closes modal immediately when Retry is clicked (before API call)", async () => {
      const onClose = vi.fn();
      const onRetryTask = vi.fn(async () => ({}) as Task);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={onClose}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={onRetryTask}
          addToast={noop}
        />,
      );

      // Open Actions dropdown and click Retry
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });

      const retryBtn = screen.getByRole("menuitem", { name: "Retry" });
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      // Modal should close immediately (optimistic close before API call)
      expect(onClose).toHaveBeenCalledTimes(1);
      // onRetryTask should still be called with the correct task ID
      expect(onRetryTask).toHaveBeenCalledWith("FN-099");
    });

    it("shows exactly one success toast when retry succeeds", async () => {
      const onClose = vi.fn();
      const onRetryTask = vi.fn(async () => ({}) as Task);
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={onClose}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={onRetryTask}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown and click Retry
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });

      const retryBtn = screen.getByRole("menuitem", { name: "Retry" });
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      // Wait for the promise to resolve
      await act(async () => {});

      // Only one toast — the success toast, no info toast
      expect(addToast).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith("This stage will restart in its current column.", "success");
    });

    it("shows exactly one error toast when retry fails", async () => {
      const onClose = vi.fn();
      const onRetryTask = vi.fn(async () => {
        throw new Error("Server error");
      });
      const addToast = vi.fn();

      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "in-review", status: "failed" })}
          onClose={onClose}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          onRetryTask={onRetryTask}
          addToast={addToast}
        />,
      );

      // Open Actions dropdown and click Retry
      const actionsBtn = screen.getByRole("button", { name: "Actions" });
      await act(async () => {
        fireEvent.click(actionsBtn);
      });

      const retryBtn = screen.getByRole("menuitem", { name: "Retry" });
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      // Wait for the promise to reject
      await act(async () => {});

      // Only one toast — the error toast
      expect(addToast).toHaveBeenCalledTimes(1);
      expect(addToast).toHaveBeenCalledWith("Server error", "error");
    });

  });

  it("shows description exactly once for a task without title", () => {
    const { container } = render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          title: undefined,
          description: "Fix the login bug",
          prompt: "# KB-099\n\nFix the login bug\n",
        })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    // The heading "FN-099" should be stripped from the markdown
    const markdownBody = document.querySelector(".markdown-body");
    expect(markdownBody?.innerHTML).not.toContain("FN-099");
    // Description appears in the markdown body
    expect(markdownBody?.textContent).toContain("Fix the login bug");
    // The detail header shows the ID (not duplicated as markdown heading)
    expect(document.querySelector(".detail-id")?.textContent).toBe("FN-099");
    // The h2 title shows description, not the task ID
    const h2 = document.querySelector("h2.detail-title");
    expect(h2?.textContent).toBe("Fix the login bug");
  });

  it("shows the title in <h2> when task.title is set", () => {
    const { container } = render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          title: "Implement dark mode",
          description: "Add dark mode toggle to the settings page",
        })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const h2 = document.querySelector("h2.detail-title");
    expect(h2?.textContent).toBe("Implement dark mode");
  });

  describe("description truncation", () => {
    let titleScrollHeight = 0;
    let titleClientHeight = 0;
    let titleResizeObservers: Array<{ callback: ResizeObserverCallback; disconnected: boolean }> = [];
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");

    const setTitleLayout = ({ scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) => {
      titleScrollHeight = scrollHeight;
      titleClientHeight = clientHeight;
    };

    const renderDetail = (taskOverrides: Parameters<typeof makeTask>[0] = {}) => render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask(taskOverrides)}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const expectNoStandaloneTitleToggle = () => {
      expect(document.querySelector(".detail-description-toggle")).toBeNull();
      expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
    };

    beforeEach(() => {
      setTitleLayout({ scrollHeight: 120, clientHeight: 40 });
      titleResizeObservers = [];
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: class TitleResizeObserver {
          private readonly observation: { callback: ResizeObserverCallback; disconnected: boolean };

          constructor(callback: ResizeObserverCallback) {
            this.observation = { callback, disconnected: false };
            titleResizeObservers.push(this.observation);
          }

          observe() {}
          unobserve() {}
          disconnect() { this.observation.disconnected = true; }
        },
      });
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get() {
          return this instanceof HTMLElement && this.classList.contains("detail-title-measurement") ? titleScrollHeight : 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get() {
          return this instanceof HTMLElement && this.classList.contains("detail-title-measurement") ? titleClientHeight : 0;
        },
      });
    });

    afterEach(() => {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      }
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    });

    it("toggles a long triage title directly without a standalone affordance", async () => {
      /*
      FNXC:TaskDetailTitle 2026-08-04-18:00:
      Every TaskDetailModal lifecycle column and title fallback shares this definition header. An overflowed title alone owns expansion for pointer, touch, and keyboard users; short and fallback headings retain no empty control or legacy Show more/Show less shell, while Summarize remains separate.
      */
      const longTitle = "Triage title ".repeat(25);
      renderDetail({
        column: "triage",
        title: longTitle,
        description: "Triage planning context",
      });

      const h2 = document.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe(longTitle);
      expect(h2).toHaveClass("detail-title--collapsed");
      const titleControl = await screen.findByRole("button", { name: "Expand task title" });
      expect(titleControl).toHaveAttribute("aria-expanded", "false");
      expectNoStandaloneTitleToggle();

      await userEvent.click(titleControl);

      expect(document.querySelector("h2.detail-title")?.textContent).toBe(longTitle);
      expect(document.querySelector("h2.detail-title")).not.toHaveClass("detail-title--collapsed");
      expect(screen.getByRole("button", { name: "Collapse task title" })).toHaveAttribute("aria-expanded", "true");
      expectNoStandaloneTitleToggle();

      await userEvent.click(screen.getByRole("button", { name: "Collapse task title" }));

      expect(document.querySelector("h2.detail-title")).toHaveClass("detail-title--collapsed");
      expect(screen.getByRole("button", { name: "Expand task title" })).toHaveAttribute("aria-expanded", "false");
      expectNoStandaloneTitleToggle();
    });

    it("keeps the modal title control stable through repeated resize callbacks after each activation", async () => {
      const longTitle = "Resize-safe title ".repeat(25);
      renderDetail({ title: longTitle });

      const titleControl = await screen.findByRole("button", { name: "Expand task title" });
      const measuredText = document.querySelector(".detail-title-measurement");
      const collapsedObserver = titleResizeObservers.at(-1);
      expect(collapsedObserver).toBeDefined();
      expect(measuredText?.textContent).toBe(longTitle);

      await userEvent.click(titleControl);
      expect(document.querySelector("h2.detail-title")).not.toHaveClass("detail-title--collapsed");
      expect(screen.getByRole("button", { name: "Collapse task title" })).toBe(titleControl);
      expect(titleControl).toHaveAttribute("aria-expanded", "true");
      expect(document.querySelector(".detail-title-measurement")).toBe(measuredText);
      expect(document.querySelector("h2.detail-title")?.textContent).toBe(longTitle);
      expect(collapsedObserver?.disconnected).toBe(true);

      // Delivery can race disconnect; a stale collapsed-layout observer must not reclaim the choice.
      await act(async () => {
        for (let index = 0; index < 3; index++) {
          collapsedObserver?.callback([], {} as ResizeObserver);
        }
      });
      expect(screen.getByRole("button", { name: "Collapse task title" })).toBe(titleControl);
      expect(titleControl).toHaveAttribute("aria-expanded", "true");
      expect(screen.getAllByRole("button", { name: "Collapse task title" })).toHaveLength(1);

      await userEvent.click(titleControl);
      const recollapsedObserver = titleResizeObservers.at(-1);
      expect(document.querySelector("h2.detail-title")).toHaveClass("detail-title--collapsed");
      expect(document.querySelector(".detail-title-measurement")).toBe(measuredText);
      expect(screen.getByRole("button", { name: "Expand task title" })).toBe(titleControl);
      expect(titleControl).toHaveAttribute("aria-expanded", "false");
      expect(recollapsedObserver).not.toBe(collapsedObserver);

      await act(async () => {
        for (let index = 0; index < 3; index++) {
          recollapsedObserver?.callback([], {} as ResizeObserver);
        }
      });
      expect(document.querySelector("h2.detail-title")).toHaveClass("detail-title--collapsed");
      expect(screen.getByRole("button", { name: "Expand task title" })).toBe(titleControl);
      expect(screen.getAllByRole("button", { name: "Expand task title" })).toHaveLength(1);
      expect(document.querySelector("h2.detail-title")?.textContent).toBe(longTitle);
      expectNoStandaloneTitleToggle();
    });

    it("keeps the embedded narrow title choice stable and ignores a switched task's stale observer", async () => {
      const longTitle = "Embedded mobile title ".repeat(25);
      const props = {
        embedded: true,
        active: true,
        initialTab: "definition" as const,

        onDeleteTask: noopDelete,
        onMergeTask: noopMerge,
        onOpenDetail: noopOpenDetail,
        addToast: noop,
      };
      const originalInnerWidth = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
      const { rerender } = render(<TaskDetailContent {...props} task={makeTask({ id: "FN-EMBEDDED", title: longTitle })} />);
      fireEvent(window, new Event("resize"));

      const titleControl = await screen.findByRole("button", { name: "Expand task title" });
      const oldObserver = titleResizeObservers.at(-1);
      await userEvent.click(titleControl);
      await act(async () => {
        oldObserver?.callback([], {} as ResizeObserver);
        oldObserver?.callback([], {} as ResizeObserver);
      });
      expect(document.querySelector("h2.detail-title")).not.toHaveClass("detail-title--collapsed");
      expect(screen.getByRole("button", { name: "Collapse task title" })).toBe(titleControl);

      setTitleLayout({ scrollHeight: 40, clientHeight: 40 });
      rerender(<TaskDetailContent {...props} task={makeTask({ id: "FN-EMBEDDED-NEXT", title: "Narrow fitting title" })} />);
      await act(async () => {});
      expect(document.querySelector("h2.detail-title")?.textContent).toBe("Narrow fitting title");
      expect(screen.queryByRole("button", { name: /task title/ })).toBeNull();
      expect(oldObserver?.disconnected).toBe(true);

      await act(async () => {
        oldObserver?.callback([], {} as ResizeObserver);
        oldObserver?.callback([], {} as ResizeObserver);
      });
      expect(screen.queryByRole("button", { name: /task title/ })).toBeNull();
      expectNoStandaloneTitleToggle();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    });

    it("ignores title observer deliveries while a kept-alive pop-out is hidden", async () => {
      setTitleLayout({ scrollHeight: 40, clientHeight: 40 });
      const props = {
        embedded: true,
        active: true,
        initialTab: "definition" as const,

        onDeleteTask: noopDelete,
        onMergeTask: noopMerge,
        onOpenDetail: noopOpenDetail,
        addToast: noop,
      };
      const { rerender } = render(<TaskDetailContent {...props} task={makeTask({ id: "FN-HIDDEN", title: "Visibility fenced title" })} />);
      const visibleObserver = titleResizeObservers.at(-1);
      expect(screen.queryByRole("button", { name: /task title/ })).toBeNull();

      rerender(<TaskDetailContent {...props} active={false} task={makeTask({ id: "FN-HIDDEN", title: "Visibility fenced title" })} />);
      expect(visibleObserver?.disconnected).toBe(true);
      setTitleLayout({ scrollHeight: 120, clientHeight: 40 });
      await act(async () => {
        visibleObserver?.callback([], {} as ResizeObserver);
        visibleObserver?.callback([], {} as ResizeObserver);
      });
      expect(screen.queryByRole("button", { name: /task title/ })).toBeNull();

      rerender(<TaskDetailContent {...props} active task={makeTask({ id: "FN-HIDDEN", title: "Visibility fenced title" })} />);
      expect(await screen.findByRole("button", { name: "Expand task title" })).toHaveAttribute("aria-expanded", "false");
      expectNoStandaloneTitleToggle();
    });

    it("supports keyboard activation through the title control", async () => {
      renderDetail({ title: "Keyboard title ".repeat(25) });

      const titleControl = await screen.findByRole("button", { name: "Expand task title" });
      titleControl.focus();
      await userEvent.keyboard("{Enter}");

      expect(document.querySelector("h2.detail-title")).not.toHaveClass("detail-title--collapsed");
      expect(screen.getByRole("button", { name: "Collapse task title" })).toHaveAttribute("aria-expanded", "true");
      expectNoStandaloneTitleToggle();
    });

    it("collapses a long triage description fallback by default when title is missing", async () => {
      const longDescription = "Triage description ".repeat(20);
      renderDetail({ column: "triage", title: undefined, description: longDescription });

      const h2 = document.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe(longDescription);
      expect(h2).toHaveClass("detail-title--collapsed");
      expect(await screen.findByRole("button", { name: "Expand task title" })).toHaveAttribute("aria-expanded", "false");
      expectNoStandaloneTitleToggle();
    });

    it("uses the title, description, and id fallback chain for the clamped heading", async () => {
      /*
      FNXC:TaskDetailModal 2026-07-30-23:20 (#2895 review — the portal defect, at the sites the reported
      one did not cover):

      CLEANUP BETWEEN RENDERS, NOT A WIDER SELECTOR.

      These queried the render `container`, and the modal PORTALS out of it, so every one returned
      null. The obvious repair — swap to `document.querySelector` — is wrong here and I watched it
      fail: this case renders the modal THREE times, the portals accumulate on `document.body`, and a
      document-wide query returns the FIRST one. The failure moved from "Title wins" to
      "Description fallback" rather than going away.

      Unmounting between renders makes the document unambiguous, so each assertion reads the render it
      belongs to. That also matches what the case is actually testing — three independent fallback
      inputs, not three coexisting modals.
      */
      renderDetail({ title: "Title wins", description: "Description loses" });
      expect(document.querySelector("h2.detail-title")?.textContent).toBe("Title wins");
      expect(document.querySelector("h2.detail-title")).toHaveClass("detail-title--collapsed");
      expect(await screen.findByRole("button", { name: "Expand task title" })).toBeInTheDocument();
      expectNoStandaloneTitleToggle();
      cleanup();

      setTitleLayout({ scrollHeight: 40, clientHeight: 40 });
      renderDetail({ title: undefined, description: "Description fallback" });
      expect(document.querySelector("h2.detail-title")?.textContent).toBe("Description fallback");
      expect(screen.queryByRole("button", { name: "Expand task title" })).toBeNull();
      expectNoStandaloneTitleToggle();
      cleanup();

      renderDetail({ id: "FN-FALLBACK", title: undefined, description: undefined });
      expect(document.querySelector("h2.detail-title")?.textContent).toBe("FN-FALLBACK");
      expect(screen.queryByRole("button", { name: "Expand task title" })).toBeNull();
      expectNoStandaloneTitleToggle();
    });

    it.each(["todo", "in-progress", "in-review", "done"] as const)(
      "collapses overflowing non-triage %s titles with a title-owned control",
      async (column) => {
        const longTitle = `${column} title `.repeat(25);
        renderDetail({ column, title: longTitle });

        const h2 = document.querySelector("h2.detail-title");
        expect(h2?.textContent).toBe(longTitle);
        expect(h2).toHaveClass("detail-title--collapsed");
        expect(await screen.findByRole("button", { name: "Expand task title" })).toHaveAttribute("aria-expanded", "false");
        expectNoStandaloneTitleToggle();
      },
    );

    it("does not render an empty title control when the title fits within two lines", () => {
      setTitleLayout({ scrollHeight: 40, clientHeight: 40 });
      renderDetail({
        title: "Short title",
        description: "This is a longer description that is not shown as the heading while title is present",
      });

      const h2 = document.querySelector("h2.detail-title");
      expect(h2?.textContent).toBe("Short title");
      expect(h2).toHaveClass("detail-title--collapsed");
      expect(screen.queryByRole("button", { name: "Expand task title" })).toBeNull();
      expectNoStandaloneTitleToggle();
    });

    it("resets to collapsed when switching from a non-triage task to a triage task", async () => {
      const todoDescription = "G".repeat(250);
      const triageDescription = "H".repeat(250);
      const { rerender } = render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-TODO", column: "todo", title: undefined, description: todoDescription })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await userEvent.click(await screen.findByRole("button", { name: "Expand task title" }));
      expect(document.querySelector("h2.detail-title")).not.toHaveClass("detail-title--collapsed");

      rerender(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ id: "FN-TRIAGE", column: "triage", title: undefined, description: triageDescription })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(document.querySelector("h2.detail-title")?.textContent).toBe(triageDescription);
      });
      expect(document.querySelector("h2.detail-title")).toHaveClass("detail-title--collapsed");
      expect(screen.getByRole("button", { name: "Expand task title" })).toHaveAttribute("aria-expanded", "false");
      expectNoStandaloneTitleToggle();
    });

    it("keeps the editing title form unaffected by the read-only clamp", async () => {
      const longTitle = "Editable title ".repeat(25);
      renderDetail({ column: "todo", title: longTitle, description: "Editable description" });

      expect(await screen.findByRole("button", { name: "Expand task title" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Edit task" }));

      expect(document.querySelector("h2.detail-title")).toBeNull();
      expectNoStandaloneTitleToggle();
      expect(screen.getByLabelText("Title")).toHaveValue(longTitle);
    });

    it("keeps the summarize-title affordance distinct from title expansion", async () => {
      renderDetail({
        column: "todo",
        title: "Summarize me ".repeat(25),
        description: "Description available for summarization",
      });

      expect(document.querySelector(".detail-heading-row h2.detail-title--collapsed")).toBeInTheDocument();
      const titleControl = await screen.findByRole("button", { name: "Expand task title" });
      const summarizeButton = screen.getByTestId("summarize-title-btn");
      expect(summarizeButton).not.toBe(titleControl);
      await userEvent.click(summarizeButton);
      expect(titleControl).toHaveAttribute("aria-expanded", "false");
      expectNoStandaloneTitleToggle();
    });

    it("keeps the clamp available in chat-expanded layout", async () => {
      render(
        <TaskDetailContent
          task={makeTask({
            column: "todo",
            title: "Chat expanded title ".repeat(25),
            description: "Description",
          })}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
          initialTab="chat"
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Expand activity to full modal" }));

      expect(document.querySelector(".task-detail-content--chat-expanded")).toBeInTheDocument();
      expect(document.querySelector("h2.detail-title")).toHaveClass("detail-title--collapsed");
      expect(await screen.findByRole("button", { name: "Expand task title" })).toBeInTheDocument();
      expectNoStandaloneTitleToggle();
    });

    it("has desktop and mobile CSS rules that preserve the two-line title clamp", () => {
      const css = readDashboardStylesSource();
      expect(css).toContain(".detail-title--collapsed");
      expectBaseRule(css, ".detail-title--collapsed .detail-title-measurement", "-webkit-line-clamp: 2");
      expectBaseRule(css, ".detail-title--collapsed .detail-title-measurement", "line-clamp: 2");
      expectBaseRule(css, ".detail-title-control", "width: 100%");
      expectBaseRule(css, ".detail-title-control:focus-visible", "box-shadow: var(--focus-ring-strong)");
      expect(css).toContain("@media (max-width: 768px)");
      expectBaseRule(css, ".detail-title", "font-size: 16px");
      expect(css).not.toContain(".detail-description-toggle");
    });
  });

  it("always shows task.id in the detail-id badge regardless of title", () => {
    // With title
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ title: "Some title" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    /* Portaled, and rendered twice — see the cleanup note on the clamped-heading case. */
    expect(document.querySelector(".detail-id")?.textContent).toBe("FN-099");
    cleanup();

    // Without title
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ title: undefined, description: "A description" })}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(document.querySelector(".detail-id")?.textContent).toBe("FN-099");
  });

  describe("optimistic opening with Task", () => {
    beforeEach(async () => {
      await resetTaskDetailFetchMock();
      vi.mocked(dashboardApi.fetchTaskPrompt).mockReset();
      vi.mocked(dashboardApi.fetchTaskPrompt).mockResolvedValue({ id: "FN-099", prompt: "# Task FN-099" });
    });

    it("restores a resolved detail Promise after an override is reset", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(makeTask({ id: "FN-override", prompt: "# Override" }));

      await expect(mockFetch("FN-override", undefined)).resolves.toMatchObject({ id: "FN-override" });
      await resetTaskDetailFetchMock();

      /*
      FNXC:DashboardTests 2026-08-04-15:05:
      The reproducing reset sequence must never leave Definition refresh with
      Vitest's undefined return value instead of the API's Promise contract.
      */
      render(
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ prompt: "# Restored default prompt" })}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => expect(dashboardApi.fetchTaskPrompt).toHaveBeenCalledWith("FN-099", undefined));
      await waitFor(() => expect(screen.queryByText("Restored default prompt")).toBeNull());
    });

    it("renders immediately when opened with a Task prop (no prompt)", async () => {
      const { fetchTaskDetail } = await import("../../api");
      vi.mocked(fetchTaskDetail).mockResolvedValueOnce({
        id: "FN-200",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Spec",
      } as TaskDetail);

      const task: Task = {
        id: "FN-200",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      /* Same obsolete selector as the wrapper case: the shell is FloatingWindow, not `.modal-overlay`. */
      expect(document.querySelector(".floating-window-overlay--modal")).toBeTruthy();
      expect(screen.getByText("FN-200")).toBeDefined();
    });

    it("calls fetchTaskDetail on mount when prop is Task without prompt", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      mockFetch.mockResolvedValueOnce({
        id: "FN-201",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Spec",
      } as TaskDetail);

      const task: Task = {
        id: "FN-201",
        description: "Optimistic task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("FN-201", undefined);
      });
    });

    it("uses a prompt-only Definition refresh when prop is already a TaskDetail with prompt", async () => {
      const mockPromptFetch = vi.mocked(dashboardApi.fetchTaskPrompt);
      const mockFetch = vi.mocked(dashboardApi.fetchTaskDetail);

      const detail: TaskDetail = {
        id: "FN-202",
        description: "Full detail task",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        prompt: "# Full spec",
      } as TaskDetail;

      render(
        <TaskDetailModal
          initialTab="definition"
          task={detail}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // A full detail skips the full client; Definition reads only its prompt.
      await waitFor(() => expect(mockPromptFetch).toHaveBeenCalledWith("FN-202", undefined));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("retains the last good prompt when Definition refresh rejects", async () => {
      const mockFetch = vi.mocked(dashboardApi.fetchTaskPrompt);
      const detail = makeTask({ id: "FN-202-rejected", prompt: "# Last good prompt" });
      mockFetch.mockRejectedValueOnce(new Error("refresh failed"));

      render(
        <TaskDetailModal
          initialTab="definition"
          task={detail}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("FN-202-rejected", undefined));
      expect(screen.getByText("Last good prompt")).toBeInTheDocument();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    /*
    FNXC:TaskDetailPlan 2026-08-04-15:21:
    Definition refresh is lifecycle-owned, not modal-owned: embedded kept-alive hosts
    must defer while hidden, refresh immediately on reveal, keep one request during a
    pending interval tick, and stop polling again when hidden. Exercise that actual
    visibility sequence so a mock-default repair cannot hide a broken refresh fence.
    */
    it("defers embedded refresh while inactive, deduplicates pending interval work, and resumes on re-show", async () => {
      vi.useFakeTimers();
      try {
        const mockFetch = vi.mocked(dashboardApi.fetchTaskPrompt);
        let resolveFirstRequest: (detail: { id: string; prompt?: string }) => void = () => undefined;
        mockFetch.mockImplementationOnce(() => new Promise<{ id: string; prompt?: string }>((resolve) => {
          resolveFirstRequest = resolve;
        }));
        mockFetch.mockResolvedValueOnce({ id: "FN-lifecycle", prompt: "# Interval refresh" });
        mockFetch.mockResolvedValue({ id: "FN-lifecycle", prompt: "# Re-shown refresh" });
        const props = {
          embedded: true,
          initialTab: "definition" as const,
          task: makeTask({ id: "FN-lifecycle", status: "planning", prompt: "# Initial prompt" }),

          onDeleteTask: noopDelete,
          onMergeTask: noopMerge,
          onOpenDetail: noopOpenDetail,
          addToast: noop,
        };

        const { rerender } = render(<TaskDetailContent {...props} active={false} />);
        expect(mockFetch).not.toHaveBeenCalled();

        rerender(<TaskDetailContent {...props} active />);
        await act(async () => {});
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await act(async () => { resolveFirstRequest({ id: "FN-lifecycle", prompt: "# First refresh" }); });
        expect(screen.getByText("First refresh")).toBeInTheDocument();

        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(mockFetch).toHaveBeenCalledTimes(2);

        rerender(<TaskDetailContent {...props} active={false} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(mockFetch).toHaveBeenCalledTimes(2);

        rerender(<TaskDetailContent {...props} active />);
        await act(async () => {});
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fences a cancelled embedded refresh after a visible task switch", async () => {
      const mockFetch = vi.mocked(dashboardApi.fetchTaskPrompt);
      let resolveStaleRequest: (detail: { id: string; prompt?: string }) => void = () => undefined;
      let resolveCurrentRequest: (detail: { id: string; prompt?: string }) => void = () => undefined;
      mockFetch
        .mockImplementationOnce(() => new Promise<{ id: string; prompt?: string }>((resolve) => { resolveStaleRequest = resolve; }))
        .mockImplementationOnce(() => new Promise<{ id: string; prompt?: string }>((resolve) => { resolveCurrentRequest = resolve; }));
      const sharedProps = {
        embedded: true,
        initialTab: "definition" as const,

        onDeleteTask: noopDelete,
        onMergeTask: noopMerge,
        onOpenDetail: noopOpenDetail,
        addToast: noop,
      };
      const staleTask = makeTask({ id: "FN-stale-detail", prompt: "# Stale initial" });
      const currentTask = makeTask({ id: "FN-current-detail", prompt: "# Current initial" });

      const { rerender } = render(<TaskDetailContent {...sharedProps} task={staleTask} active />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("FN-stale-detail", undefined));

      rerender(<TaskDetailContent {...sharedProps} task={staleTask} active={false} />);
      rerender(<TaskDetailContent {...sharedProps} task={currentTask} active />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("FN-current-detail", undefined));

      await act(async () => { resolveCurrentRequest({ id: "FN-current-detail", prompt: "# Current response" }); });
      expect(await screen.findByText("Current response")).toBeInTheDocument();

      await act(async () => { resolveStaleRequest({ id: "FN-stale-detail", prompt: "# Stale response" }); });
      expect(screen.queryByText("Stale response")).toBeNull();
      expect(screen.getByText("Current response")).toBeInTheDocument();
    });

    it("shows loading state in spec area when detailLoading is true", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);
      // Set up a pending promise so loading state persists
      mockFetch.mockResolvedValueOnce(new Promise(() => {}) as any);

      const task: Task = {
        id: "FN-203",
        description: "Loading spec test",
        column: "todo",
        dependencies: [],
        steps: [{ name: "Plan", status: "in-progress" }],
        currentStep: 0,
        log: [{ timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] setup in 120ms" }],
        executionMode: "fast",
        status: "executing",
        assignedAgentId: "agent-loading",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      expect(screen.getByText("Loading specification…")).toBeDefined();
      // Token stats now live in their own Stats tab — switch to it before
      // asserting on token-loading text.
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      expect(screen.getByText("Execution Timing")).toBeInTheDocument();
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
      expect(screen.getByText("Loading token statistics…")).toBeDefined();
      expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
      expectSingleStatsRuntimeStatus("executing");
    });

    it("shows spec content after fetchTaskDetail resolves", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const task: Task = {
        id: "FN-204",
        description: "Async spec test",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      const fullDetail: TaskDetail = {
        ...task,
        prompt: "# Async Spec\n\nThis is the loaded spec content.",
        log: [
          { timestamp: "2026-04-24T09:00:00.000Z", action: "[timing] prepare env in 120ms" },
          { timestamp: "2026-04-24T09:01:00.000Z", action: "[timing] run tests in 3400ms" },
        ],
        workflowStepResults: [
          {
            workflowStepId: "WS-101",
            workflowStepName: "Workflow QA",
            status: "passed",
            startedAt: "2026-04-24T09:10:00.000Z",
            completedAt: "2026-04-24T09:10:07.000Z",
          },
        ],
        executionMode: "fast",
        status: "executing",
        mergeRetries: 1,
        workflowStepRetries: 2,
        recoveryRetryCount: 3,
        taskDoneRetryCount: 4,
        tokenUsage: {
          inputTokens: 1200,
          outputTokens: 450,
          cachedTokens: 210,
          cacheWriteTokens: 15,
          totalTokens: 1860,
          firstUsedAt: "2026-04-24T09:00:00.000Z",
          lastUsedAt: "2026-04-24T10:15:00.000Z",
        },
      } as TaskDetail;

      // Resolve with full detail
      mockFetch.mockResolvedValueOnce(fullDetail);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Initially shows loading
      expect(screen.getByText("Loading specification…")).toBeDefined();

      // After fetch resolves, spec content appears
      await waitFor(() => {
        const markdownBody = document.querySelector(".markdown-body");
        expect(markdownBody).toBeTruthy();
      }, { timeout: 3000 });

      // Loading indicator should be gone
      expect(screen.queryByText("Loading specification…")).toBeNull();

      // Token stats live behind the Stats tab now.
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      expect(screen.queryByText("Loading token statistics…")).toBeNull();
      expect(screen.getByText("Execution Timing")).toBeInTheDocument();
      expect(screen.getByText("Execution Details")).toBeInTheDocument();
      expect(screen.getByText("Timing events")).toBeInTheDocument();
      expect(screen.getByText("Workflow runtime")).toBeInTheDocument();
      expect(screen.getByText("Execution mode")).toBeInTheDocument();
      expect(screen.getByText("Runtime status")).toBeInTheDocument();
      expect(screen.getAllByText("Fast").length).toBeGreaterThan(0);
      expectSingleStatsRuntimeStatus("executing");
      const statsPanel = screen.getByRole("region", { name: "Task execution statistics" });
      expect(within(statsPanel).getByText((1200).toLocaleString())).toBeInTheDocument();
      expect(within(statsPanel).getByText((450).toLocaleString())).toBeInTheDocument();
      expect(within(statsPanel).getByText((210).toLocaleString())).toBeInTheDocument();
      expect(within(statsPanel).getByText((1860).toLocaleString())).toBeInTheDocument();
      const firstUsed = document.querySelector('time[datetime="2026-04-24T09:00:00.000Z"]');
      const lastUsed = document.querySelector('time[datetime="2026-04-24T10:15:00.000Z"]');
      expect(firstUsed).toBeTruthy();
      expect(lastUsed).toBeTruthy();
    });

    it("preserves fullDetail.log when SSE-stripped task prop has empty log", async () => {
      // Regression: SSE strips `log` to [] in task list payloads (see
      // stripTaskListHeavyFields in packages/dashboard/src/sse.ts). The modal
      // merges live `task` over `fullDetail` to keep tokenUsage/status fresh,
      // which previously clobbered fullDetail.log and emptied the Activity tab.
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const strippedTask: Task = {
        id: "FN-LOG-1",
        description: "SSE stripped task",
        column: "in-progress",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValueOnce({
        ...strippedTask,
        prompt: "# Spec",
        log: [
          { timestamp: "2026-04-24T09:00:00.000Z", action: "Created task" },
          { timestamp: "2026-04-24T09:01:00.000Z", action: "Started executor", outcome: "OK" },
        ],
      } as TaskDetail);

      const { container } = render(
        <TaskDetailModal
          initialTab="definition"
          task={strippedTask}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Wait for fetchTaskDetail to resolve.
      await waitFor(() => {
        expect(document.querySelector(".markdown-body")).toBeTruthy();
      }, { timeout: 3000 });

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Feed" }));

      const activityList = document.querySelector(".detail-activity-list");
      expect(activityList).toBeTruthy();
      const logEntries = document.querySelectorAll(".detail-log-entry");
      expect(logEntries).toHaveLength(2);
      expect(logEntries[0].textContent).toContain("Started executor");
      expect(logEntries[1].textContent).toContain("Created task");
    });

    it("shows token stats empty state once detail is loaded without usage", async () => {
      const { fetchTaskDetail } = await import("../../api");
      const mockFetch = vi.mocked(fetchTaskDetail);

      const task: Task = {
        id: "FN-205",
        description: "No token stats",
        column: "todo",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as Task;

      mockFetch.mockResolvedValueOnce({
        ...task,
        prompt: "# Async Spec\n\nSpec without usage.",
        tokenUsage: undefined,
      } as TaskDetail);

      render(
        <TaskDetailModal
          initialTab="definition"
          task={task}
          onClose={noop}

          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );

      // Token stats live behind the Stats tab now — wait for the modal to
      // settle, then switch tabs and assert on the empty state.
      await waitFor(() => {
        expect(screen.queryByText("Loading specification…")).toBeNull();
      });
      fireEvent.click(screen.getByRole("button", { name: "Stats" }));
      await waitFor(() => {
        expect(screen.getByText("No token usage recorded for this task yet.")).toBeInTheDocument();
      });
    });
  });

  it("clears the duplicate flag from the near-duplicate banner", async () => {
    const { updateTask } = await import("../../api");
    const mockUpdateTask = vi.mocked(updateTask);
    mockUpdateTask.mockResolvedValueOnce(makeTask({
      id: "FN-099",
      sourceMetadata: { nearDuplicateOf: "FN-1234", nearDuplicateDismissed: true },
    }));

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        tasks={[makeTask({ id: "FN-1234" })]}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Potential duplicate detected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("FN-099", { dismissNearDuplicate: true }, undefined);
    });
  });


  it("hides near-duplicate banner once dismissed", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234", nearDuplicateDismissed: true } })}
        tasks={[makeTask({ id: "FN-1234" })]}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Potential duplicate detected")).toBeNull();
  });

  it.each([
    ["done", makeTask({ id: "FN-1234", column: "done" })],
    ["missing", undefined],
  ])("hides near-duplicate decision banner when canonical is %s", (_label, canonical) => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        tasks={canonical ? [canonical] : []}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Potential duplicate detected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark the duplicate flag for FN-1234 as read" })).toBeNull();
  });

  it("deletes from the near-duplicate banner when confirmed", async () => {
    const onDeleteTask = vi.fn().mockResolvedValue(makeTask());
    mockConfirm.mockResolvedValueOnce(true);

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234" } })}
        tasks={[makeTask({ id: "FN-1234" })]}
        onClose={noop}

        onDeleteTask={onDeleteTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { removeLineageReferences: true });
    });
  });

  it("deletes a triage-marker duplicate through the shared delete API", async () => {
    const onDeleteTask = vi.fn().mockResolvedValue(makeTask());
    mockConfirm.mockResolvedValueOnce(true);

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ sourceMetadata: { nearDuplicateOf: "FN-1234", duplicateSource: "triage-marker" } })}
        tasks={[makeTask({ id: "FN-1234" })]}
        onClose={noop}

        onDeleteTask={onDeleteTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Keep it to clear this flag, or delete it if the work is already covered.");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { removeLineageReferences: true });
    });
  });

  it("renders corrected stats timing totals in Stats tab", async () => {
    const { fetchTaskDetail } = await import("../../api");
    const mockFetch = vi.mocked(fetchTaskDetail);

    const task: Task = {
      id: "FN-206",
      description: "Stats timing regression",
      column: "done",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as Task;

    mockFetch.mockResolvedValueOnce({
      ...task,
      prompt: "# Async Spec\n\nStats timing regression.",
      executionStartedAt: "2026-05-15T13:10:00.000Z",
      executionCompletedAt: "2026-05-15T13:14:00.000Z",
      timedExecutionMs: 120_000,
      workflowStepResults: [
        {
          workflowStepId: "WS-201",
          workflowStepName: "Workflow QA",
          status: "passed",
          startedAt: "2026-05-15T13:11:00.000Z",
          completedAt: "2026-05-15T13:12:00.000Z",
        },
      ],
    } as TaskDetail);

    render(
      <TaskDetailModal
        initialTab="definition"
        task={task}
        onClose={noop}

        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading specification…")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stats" }));

    await waitFor(() => {
      const metric = screen.getByText("Total execution time").closest(".task-token-stats-panel__metric");
      expect(metric).toHaveTextContent("4m 0s");
    });
  });


});
