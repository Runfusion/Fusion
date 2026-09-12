import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchnodeFeed } from "@fusion/core";
import { readAppFile } from "../../test/cssFixture";

const { fetchPatchnode } = vi.hoisted(() => ({ fetchPatchnode: vi.fn() }));
vi.mock("../../api", () => ({ fetchPatchnode }));

import { PatchnodeView } from "../PatchnodeView";

const feed: PatchnodeFeed = {
  days: [
    {
      day: "2026-08-28",
      completedCount: 1,
      revertedCount: 0,
      entries: [{ entryId: "completed:FN-2:2", taskId: "FN-2", kind: "completed", occurrenceKey: "2", day: "2026-08-28", occurredAt: "2026-08-28T11:00:00Z", title: "Search", body: "Added search" }],
    },
    {
      day: "2026-08-27",
      completedCount: 1,
      revertedCount: 1,
      entries: [
        { entryId: "reverted:FN-1:1", taskId: "FN-1", kind: "reverted", occurrenceKey: "1", day: "2026-08-27", occurredAt: "2026-08-27T12:00:00Z", title: "Ledger", body: "Cancelled delivery", revertsEntryId: "completed:FN-1:1" },
        { entryId: "completed:FN-1:1", taskId: "FN-1", kind: "completed", occurrenceKey: "1", day: "2026-08-27", occurredAt: "2026-08-27T10:00:00Z", title: "Ledger", body: "Added ledger", revertedAt: "2026-08-27T12:00:00Z" },
      ],
    },
  ],
  totalEntries: 3,
  hasMore: false,
};

describe("PatchnodeView", () => {
  beforeEach(() => {
    fetchPatchnode.mockReset().mockResolvedValue(feed);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders History copy in the title, search, and loading state", () => {
    fetchPatchnode.mockImplementation(() => new Promise(() => undefined));
    render(<PatchnodeView />);
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search History")).toBeInTheDocument();
    expect(screen.getByText("Loading History…")).toBeInTheDocument();
  });

  it("renders History copy for a failed request", async () => {
    fetchPatchnode.mockRejectedValue(new Error("unavailable"));
    render(<PatchnodeView />);
    expect(await screen.findByText("History could not be loaded.")).toBeInTheDocument();
  });

  it("renders a friendly empty state", async () => {
    fetchPatchnode.mockResolvedValue({ days: [], totalEntries: 0, hasMore: false });
    render(<PatchnodeView />);
    expect(await screen.findByTestId("patchnode-empty")).toHaveTextContent("Completed work will appear here day by day.");
    expect(screen.queryByTestId(/patchnode-day-/)).toBeNull();
  });

  it("keeps the fixed header outside the populated multi-day scroll body", async () => {
    const css = readAppFile("components/PatchnodeView.css");
    expect(css).toMatch(/\.patchnode-view\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.patchnode-view__content\s*\{[^}]*overflow-y:\s*auto;/s);

    const { container } = render(<PatchnodeView floating={{ onClose: vi.fn() }} />);
    expect(await screen.findByTestId("patchnode-day-2026-08-28")).toBeInTheDocument();
    expect(screen.getByTestId("patchnode-day-2026-08-27")).toBeInTheDocument();
    const view = screen.getByTestId("patchnode-view");
    const header = view.querySelector(":scope > .view-header");
    const scrollBody = view.querySelector(":scope > .patchnode-view__content");
    expect(header).toBeInTheDocument();
    expect(scrollBody).toBeInTheDocument();
    expect(scrollBody?.contains(header)).toBe(false);
    expect(view.children[0]).toBe(header);
    expect(view.children[1]).toBe(scrollBody);
    expect(screen.getAllByRole("button", { name: "Close History" })).toHaveLength(1);
    expect(container.querySelector(".floating-window__close")).toBeNull();
    const older = screen.getByTestId("patchnode-day-2026-08-27");
    expect(older.querySelectorAll(".patchnode-entry")[0]).toHaveTextContent("Cancelled delivery");
  });

  it("paginates through the sentinel rooted in the History scroll body", async () => {
    let observerCallback: IntersectionObserverCallback | undefined;
    let observerRoot: Element | Document | null | undefined;
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observerCallback = callback;
        observerRoot = options?.root;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    fetchPatchnode
      .mockResolvedValueOnce({ ...feed, hasMore: true })
      .mockResolvedValueOnce({ days: [], totalEntries: 3, hasMore: false });

    render(<PatchnodeView />);
    const scrollBody = await screen.findByTestId("patchnode-auto-pagination-sentinel").then((sentinel) => sentinel.parentElement);
    await waitFor(() => expect(observerCallback).toBeTypeOf("function"));
    expect(scrollBody).toHaveClass("patchnode-view__content");
    expect(observerRoot).toBe(scrollBody);

    await act(async () => {
      observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchPatchnode).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50, offset: 3 }), undefined));
  });

  it("re-queries after the search debounce", async () => {
    vi.useFakeTimers();
    render(<PatchnodeView />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByTestId("patchnode-search"), { target: { value: "ledger" } });
    await act(async () => { vi.advanceTimersByTime(250); await Promise.resolve(); });
    expect(fetchPatchnode).toHaveBeenLastCalledWith(expect.objectContaining({ query: "ledger" }), undefined);
  });

  it("keeps the query while showing a no-results state", async () => {
    fetchPatchnode.mockResolvedValueOnce(feed).mockResolvedValue({ days: [], totalEntries: 0, hasMore: false });
    render(<PatchnodeView />);
    await screen.findByTestId("patchnode-day-2026-08-28");
    fireEvent.change(screen.getByTestId("patchnode-search"), { target: { value: "missing" } });
    await waitFor(() => expect(screen.getByTestId("patchnode-empty")).toHaveTextContent("No deliveries match this search."), { timeout: 1_000 });
    expect(screen.getByTestId("patchnode-search")).toHaveValue("missing");
  });

  it("renders a non-empty title fallback body", async () => {
    fetchPatchnode.mockResolvedValue({ ...feed, days: [{ ...feed.days[0]!, entries: [{ ...feed.days[0]!.entries[0]!, body: "Search" }] }] });
    render(<PatchnodeView />);
    expect(await screen.findByText("Search", { selector: ".patchnode-entry__body" })).toBeInTheDocument();
  });

  it("renders cancelled and reverted treatments", async () => {
    render(<PatchnodeView />);
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Reverted")).toBeInTheDocument();
  });

  it("opens task detail by task id", async () => {
    const onOpenTaskDetail = vi.fn();
    render(<PatchnodeView onOpenTaskDetail={onOpenTaskDetail} />);
    fireEvent.click(await screen.findByTestId("patchnode-entry-completed:FN-2:2"));
    expect(onOpenTaskDetail).toHaveBeenCalledWith("FN-2");
  });

  it("renders both deliveries of one task on their own days", async () => {
    const duplicate = { ...feed.days[1]!.entries[1]!, entryId: "completed:FN-2:1", taskId: "FN-2", body: "Earlier summary" };
    fetchPatchnode.mockResolvedValue({ ...feed, days: [feed.days[0]!, { ...feed.days[1]!, entries: [duplicate], revertedCount: 0 }] });
    render(<PatchnodeView />);
    expect(await screen.findByText("Added search")).toBeInTheDocument();
    expect(screen.getByText("Earlier summary")).toBeInTheDocument();
  });

  it("keeps deleted-task history readable and fails detail lookup softly", async () => {
    const onOpenTaskDetail = vi.fn().mockRejectedValue(new Error("not found"));
    render(<PatchnodeView onOpenTaskDetail={onOpenTaskDetail} />);
    const entry = await screen.findByTestId("patchnode-entry-completed:FN-2:2");
    expect(entry).toHaveTextContent("Search");
    expect(entry).toHaveTextContent("Added search");
    fireEvent.click(entry);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("patchnode-view")).toBeInTheDocument();
  });
});
