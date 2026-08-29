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
import { msg } from "./sseTestHelpers";

const task = (id: string, status: string): Task => ({ id, status, title: id } as Task);

function renderApprovalBannerHook(overrides: Partial<Parameters<typeof useApprovalBanner>[0]> = {}) {
  const options: Parameters<typeof useApprovalBanner>[0] = {
    tasks: [],
    currentProjectId: "p1",
    gitHubStarPromptShown: true,
    onStarPrompt: vi.fn(),
    ...overrides,
  };
  return renderHook(() => useApprovalBanner(options));
}

describe("useApprovalBanner", () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    window.localStorage.clear();
  });

  it("does not trigger the mailbox banner when a task enters awaiting-approval", () => {
    const { result } = renderApprovalBannerHook();

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-01T00:00:00Z" }));
    });

    expect(result.current.candidate).toBeNull();
  });

  it("triggers the banner for a real approval:requested event", () => {
    const { result } = renderApprovalBannerHook();

    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }));
    });

    expect(result.current.candidate).toEqual({
      dedupeKey: "approval:a1",
      updatedAtMs: Date.parse("2026-01-01T00:00:00Z"),
    });
  });

  it("ignores approval:requested payloads without an approval request id", () => {
    const { result } = renderApprovalBannerHook();

    act(() => {
      handlers["approval:requested"]?.(msg({ taskId: "t1", updatedAt: "2026-01-01T00:00:00Z" }));
    });

    expect(result.current.candidate).toBeNull();
  });

  it("keeps task plan-approval separate when a real approval is also pending", () => {
    const { result } = renderApprovalBannerHook();

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "awaiting-approval", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(result.current.candidate).toBeNull();

    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", taskId: "t1", updatedAt: "2026-01-02T00:00:00Z" }));
    });
    expect(result.current.candidate?.dedupeKey).toBe("approval:a1");
  });

  it("fires the star prompt on the first transition to done", () => {
    const onStarPrompt = vi.fn();
    renderApprovalBannerHook({
      // Seed the status map so done is a transition from in-progress.
      tasks: [task("t1", "in-progress")],
      gitHubStarPromptShown: false,
      onStarPrompt,
    });

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "done" }));
    });

    expect(onStarPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not star-prompt again once the prompt has been shown", () => {
    const onStarPrompt = vi.fn();
    renderApprovalBannerHook({
      tasks: [task("t1", "in-progress")],
      gitHubStarPromptShown: true,
      onStarPrompt,
    });

    act(() => {
      handlers["task:updated"]?.(msg({ id: "t1", status: "done" }));
    });

    expect(onStarPrompt).not.toHaveBeenCalled();
  });

  it("dedupes a repeated approval:requested for the same key", () => {
    const { result } = renderApprovalBannerHook();

    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }));
    });
    expect(result.current.candidate?.dedupeKey).toBe("approval:a1");

    act(() => {
      handlers["approval:requested"]?.(msg({ id: "a1", updatedAt: "2026-01-02T00:00:00Z" }));
    });
    // Same dedupeKey — candidate stays at the first trigger's value.
    expect(result.current.candidate?.updatedAtMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("dismiss clears the candidate and suppresses re-trigger until a newer timestamp", () => {
    const { result } = renderApprovalBannerHook();

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
});
