/*
FNXC:TaskActivityFeedFreshness 2026-08-28-00:13:
FN-205 fixes two observable Feed failures: a prompt-bearing, log-stripped SSE snapshot cannot erase
entries already read from task detail, and a visible Feed refreshes its authoritative journal when it
opens, receives its task update, or reconnects. Every host renders TaskDetailContent, so overlay,
embedded, desktop, and mobile assertions exercise the shared contract rather than a host-specific fix.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
  taskDetailSseSubscriptions,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const SERVER_ENTRY = "Step 2 (Testing & Verification) → done";
const SECOND_ENTRY = "Task activity updated while Feed stayed open";

function renderModal(props: Partial<ComponentProps<typeof TaskDetailModal>> = {}) {
  return render(
    <TaskDetailModal
      task={makeTask({ id: "FN-FEED-1" })}
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      {...props}
    />,
  );
}

function renderEmbedded(task = strippedSnapshot()) {
  return render(
    <TaskDetailContent
      task={task}
      embedded
      initialTab="logs"
      onRequestClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

/** Exactly what an SSE snapshot looks like: spec present, journal emptied. */
function strippedSnapshot(overrides: Record<string, unknown> = {}) {
  return makeTask({
    id: "FN-FEED-1",
    column: "done" as never,
    prompt: "# Task FN-FEED-1\n\n## Steps\n\n### Step 1: Do the thing\n",
    log: [],
    ...overrides,
  });
}

function activityFeedSubscription() {
  const subscription = [...taskDetailSseSubscriptions].reverse().find(
    (candidate) => candidate.options.events?.["task:updated"],
  );
  if (!subscription) throw new Error("Expected an Activity Feed SSE subscription");
  return subscription;
}

function emitTaskUpdated(id: string): void {
  const handler = activityFeedSubscription().options.events?.["task:updated"];
  if (!handler) throw new Error("Expected an Activity Feed task:updated handler");
  act(() => handler({ data: JSON.stringify({ id }) } as MessageEvent));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Feed on a log-stripped snapshot", () => {
  it("fetches the real detail when the card opens straight onto an empty Feed", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({
      id: "FN-FEED-1",
      column: "done" as never,
      log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
    }) as never);

    renderModal({ task: strippedSnapshot(), initialTab: "logs" });

    expect(await screen.findByText(SERVER_ENTRY)).toBeInTheDocument();
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1);
  });

  it("still reports an honestly empty journal and asks once on Feed entry", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({ id: "FN-FEED-2", log: [] }) as never);

    renderModal({ task: makeTask({ id: "FN-FEED-2", prompt: "# spec", log: [] }), initialTab: "logs" });

    expect(await screen.findByText("(no activity)")).toBeInTheDocument();
    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1);
  });

  it("refreshes a populated Feed once without hiding entries while detail is pending", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    let resolveDetail!: (detail: ReturnType<typeof makeTask>) => void;
    const pendingDetail = new Promise<ReturnType<typeof makeTask>>((resolve) => {
      resolveDetail = resolve;
    });
    vi.mocked(fetchTaskDetail).mockImplementation(() => pendingDetail as never);

    renderModal({
      task: makeTask({
        id: "FN-FEED-1",
        prompt: "# Complete detail",
        log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
      }),
      initialTab: "logs",
    });

    await waitFor(() => expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1));
    expect(screen.getByText(SERVER_ENTRY)).toBeInTheDocument();
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();

    await act(async () => {
      resolveDetail(makeTask({
        id: "FN-FEED-1",
        prompt: "# Complete detail",
        log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
      }));
      await pendingDetail;
    });
  });

  it("keeps loaded entries through a newer prompt-bearing stripped parent snapshot", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({
      id: "FN-FEED-1",
      prompt: "# Complete detail",
      log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
    }) as never);

    const { rerender } = renderModal({ task: strippedSnapshot(), initialTab: "logs" });
    expect(await screen.findByText(SERVER_ENTRY)).toBeInTheDocument();

    rerender(
      <TaskDetailModal
        task={strippedSnapshot({ updatedAt: "2026-08-26T08:46:00.000Z" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        initialTab="logs"
      />,
    );

    expect(screen.getByText(SERVER_ENTRY)).toBeInTheDocument();
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
  });

  it("coalesces own-task updates into one authoritative Feed refresh", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail)
      .mockResolvedValueOnce(makeTask({
        id: "FN-FEED-1",
        prompt: "# Complete detail",
        log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
      }) as never)
      .mockResolvedValueOnce(makeTask({
        id: "FN-FEED-1",
        prompt: "# Complete detail",
        log: [
          { timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY },
          { timestamp: "2026-08-26T08:46:00.000Z", action: SECOND_ENTRY },
        ],
      }) as never);

    renderModal({ task: strippedSnapshot(), initialTab: "logs" });
    expect(await screen.findByText(SERVER_ENTRY)).toBeInTheDocument();
    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1);

    emitTaskUpdated("FN-OTHER");
    await act(async () => {
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(751);
    });
    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1);

    emitTaskUpdated("FN-FEED-1");
    emitTaskUpdated("FN-FEED-1");
    emitTaskUpdated("FN-FEED-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(751);
    });

    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(2);
    expect(screen.getByText(SECOND_ENTRY)).toBeInTheDocument();
  });

  it("follows an update received while the initial Feed refresh is still pending", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    let resolveInitialDetail!: (detail: ReturnType<typeof makeTask>) => void;
    const initialDetail = new Promise<ReturnType<typeof makeTask>>((resolve) => {
      resolveInitialDetail = resolve;
    });
    vi.mocked(fetchTaskDetail)
      .mockImplementationOnce(() => initialDetail as never)
      .mockResolvedValueOnce(makeTask({
        id: "FN-FEED-1",
        prompt: "# Complete detail",
        log: [
          { timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY },
          { timestamp: "2026-08-26T08:46:00.000Z", action: SECOND_ENTRY },
        ],
      }) as never);

    renderModal({ task: strippedSnapshot(), initialTab: "logs" });
    await waitFor(() => expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1));

    emitTaskUpdated("FN-FEED-1");
    await act(async () => {
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(751);
    });
    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    await act(async () => {
      resolveInitialDetail(makeTask({
        id: "FN-FEED-1",
        prompt: "# Complete detail",
        log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
      }));
      await initialDetail;
    });

    await waitFor(() => expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(SECOND_ENTRY)).toBeInTheDocument();
  });

  it("resyncs immediately after the Activity Feed stream reconnects", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({
      id: "FN-FEED-1",
      log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
    }) as never);

    renderModal({ task: strippedSnapshot(), initialTab: "logs" });
    expect(await screen.findByText(SERVER_ENTRY)).toBeInTheDocument();
    expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(1);

    act(() => activityFeedSubscription().options.onReconnect?.());
    await waitFor(() => expect(vi.mocked(fetchTaskDetail)).toHaveBeenCalledTimes(2));
  });

  it("keeps the journal through a stripped snapshot in an embedded host", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({
      id: "FN-FEED-1",
      log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
    }) as never);

    const { rerender } = renderEmbedded();
    expect(await screen.findByText(SERVER_ENTRY)).toBeInTheDocument();

    rerender(
      <TaskDetailContent
        task={strippedSnapshot({ updatedAt: "2026-08-26T08:46:00.000Z" })}
        embedded
        initialTab="logs"
        onRequestClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText(SERVER_ENTRY)).toBeInTheDocument();
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
  });

  it("keeps the journal through a stripped snapshot in the mobile Feed", async () => {
    const originalInnerWidth = window.innerWidth;
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    try {
      const { fetchTaskDetail } = await import("../../api");
      vi.mocked(fetchTaskDetail).mockReset();
      vi.mocked(fetchTaskDetail).mockResolvedValue(makeTask({
        id: "FN-FEED-1",
        log: [{ timestamp: "2026-08-26T08:45:40.000Z", action: SERVER_ENTRY }],
      }) as never);

      const { rerender } = renderModal({ task: strippedSnapshot(), initialTab: "logs" });
      expect(await screen.findByText(SERVER_ENTRY)).toBeInTheDocument();
      rerender(
        <TaskDetailModal
          task={strippedSnapshot({ updatedAt: "2026-08-26T08:46:00.000Z" })}
          onClose={noop}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          initialTab="logs"
        />,
      );

      expect(screen.getByText(SERVER_ENTRY)).toBeInTheDocument();
      expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
  });
});
