import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Task } from "@fusion/core";

const { handlers } = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: MessageEvent) => void>,
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: { events: Record<string, (e: MessageEvent) => void> }) => {
    Object.assign(handlers, opts.events);
    return () => {};
  }),
}));

import { useApprovalBanner } from "../useApprovalBanner";

function msg(data: object): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

const task = (id: string, status: string): Task => ({ id, status, title: id } as Task);

describe("useApprovalBanner", () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
  });

  it("triggers the banner + mailbox refresh when a task enters awaiting-approval", () => {
    const onMailboxRefresh = vi.fn();
    const { result } = renderHook(() =>
      useApprovalBanner({
        tasks: [],
        currentProjectId: "p1",
        gitHubStarPromptShown: true,
        onStarPrompt: vi.fn(),
        onMailboxRefresh,
      }),
    );

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-01T00:00:00Z" }));
    });

    expect(result.current.candidate?.dedupeKey).toBe("task:t1");
    expect(onMailboxRefresh).toHaveBeenCalledTimes(1);
  });

  it("fires the star prompt on the first transition to done", () => {
    const onStarPrompt = vi.fn();
    renderHook(() =>
      useApprovalBanner({
        // Seed the status map so done is a transition from in-progress.
        tasks: [task("t1", "in-progress")],
        currentProjectId: "p1",
        gitHubStarPromptShown: false,
        onStarPrompt,
        onMailboxRefresh: vi.fn(),
      }),
    );

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "done" }));
    });

    expect(onStarPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not star-prompt again once the prompt has been shown", () => {
    const onStarPrompt = vi.fn();
    renderHook(() =>
      useApprovalBanner({
        tasks: [task("t1", "in-progress")],
        currentProjectId: "p1",
        gitHubStarPromptShown: true,
        onStarPrompt,
        onMailboxRefresh: vi.fn(),
      }),
    );

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "done" }));
    });

    expect(onStarPrompt).not.toHaveBeenCalled();
  });

  it("dedupes a repeated approval:requested for the same key", () => {
    const { result } = renderHook(() =>
      useApprovalBanner({
        tasks: [],
        currentProjectId: "p1",
        gitHubStarPromptShown: true,
        onStarPrompt: vi.fn(),
        onMailboxRefresh: vi.fn(),
      }),
    );

    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(result.current.candidate?.dedupeKey).toBe("approval:a1");

    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-02T00:00:00Z" }));
    });
    // Same dedupeKey — candidate stays at the first trigger's value.
    expect(result.current.candidate?.dedupeKey).toBe("approval:a1");
  });

  it("dismiss clears the candidate and suppresses re-trigger until a newer timestamp", () => {
    const { result } = renderHook(() =>
      useApprovalBanner({
        tasks: [],
        currentProjectId: "p1",
        gitHubStarPromptShown: true,
        onStarPrompt: vi.fn(),
        onMailboxRefresh: vi.fn(),
      }),
    );

    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    const dismissed = result.current.candidate!;
    expect(dismissed).toBeTruthy();

    act(() => {
      result.current.dismissApproval(dismissed);
    });
    expect(result.current.candidate).toBeNull();

    // Same-or-older timestamp is suppressed after dismissal.
    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(result.current.candidate).toBeNull();
  });
  it("re-triggers after leaving and re-entering awaiting-approval (clear-on-leave)", () => {
    const onMailboxRefresh = vi.fn();
    const seedTasks: Task[] = [task("t1", "awaiting-approval")];
    const { result } = renderHook(() =>
      useApprovalBanner({
        tasks: seedTasks,
        currentProjectId: "p1",
        gitHubStarPromptShown: true,
        onStarPrompt: vi.fn(),
        onMailboxRefresh,
      }),
    );

    // The seeded awaiting-approval task is already in the seen set, so a repeat
    // event for it must NOT trigger.
    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(result.current.candidate).toBeNull();
    expect(onMailboxRefresh).not.toHaveBeenCalled();

    // Task leaves awaiting-approval → the seen-key for t1 is cleared.
    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "approved", updatedAt: "2026-01-02T00:00:00Z" }));
    });
    expect(result.current.candidate).toBeNull();

    // Re-entering awaiting-approval re-triggers the candidate + mailbox refresh.
    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-03T00:00:00Z" }));
    });
    expect(result.current.candidate?.dedupeKey).toBe("task:t1");
    expect(onMailboxRefresh).toHaveBeenCalledTimes(1);
  });

  it("dedupes mailbox refresh on a repeated awaiting-approval task:updated", () => {
    const onMailboxRefresh = vi.fn();
    const tasks: Task[] = [];
    const { result } = renderHook(() =>
      useApprovalBanner({
        tasks,
        currentProjectId: "p1",
        gitHubStarPromptShown: true,
        onStarPrompt: vi.fn(),
        onMailboxRefresh,
      }),
    );

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(result.current.candidate?.dedupeKey).toBe("task:t1");
    expect(onMailboxRefresh).toHaveBeenCalledTimes(1);

    // A second awaiting-approval for the same task is suppressed by seenApprovalKeys.
    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-04T00:00:00Z" }));
    });
    expect(onMailboxRefresh).toHaveBeenCalledTimes(1);
  });
});
