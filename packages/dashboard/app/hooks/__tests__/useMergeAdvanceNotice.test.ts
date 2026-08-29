import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMergeAdvanceNotice } from "../useMergeAdvanceNotice";

const mocked = vi.hoisted(() => ({ api: vi.fn(), mergedHandler: undefined as (() => void) | undefined }));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, api: mocked.api };
});

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { events?: Record<string, () => void> }) => {
    mocked.mergedHandler = options.events?.["task:merged"];
    return vi.fn();
  }),
}));

const eventPayload = { events: [{ taskId: "FN-1", integrationBranch: "trunk", refName: "refs/heads/trunk", toSha: "abcdef123456", fromSha: "123", advanceMode: "update-ref", succeeded: true, advancedAt: "2026", userCheckout: { worktreePath: "/repo", dirty: false, untrackedCount: 0 } }] };
const pushStatus = { integrationBranch: "trunk", branchSource: "settings" as const, hasOriginRemote: true, hasUpstream: true, localSha: "localsha", remoteSha: "remotesha", aheadCount: 2, behindCount: 0, mergeActive: false, canPush: true };

function toPath(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  if (value && typeof value === "object" && "url" in value) return String((value as { url?: unknown }).url ?? "");
  return String(value ?? "");
}

function setDefaultMocks() {
  mocked.api.mockImplementation(async (path: unknown) => {
    const target = toPath(path);
    if (target.includes("push-status")) return pushStatus;
    if (target.includes("merge-advance-events")) return eventPayload;
    return { ok: true, outcome: "ok", localSha: "localsha", remoteSha: "localsha" };
  });
}

describe("useMergeAdvanceNotice", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocked.mergedHandler = undefined;
    window.localStorage.clear();
    window.sessionStorage.clear();
    setDefaultMocks();
  });

  it("mount fetches events and push status", async () => {
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await waitFor(() => expect(result.current.pushStatus?.localSha).toBe("localsha"));
  });

  it("task:merged SSE refetches push-status", async () => {
    renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await waitFor(() => expect(mocked.api).toHaveBeenCalled());
    const before = mocked.api.mock.calls.length;
    act(() => mocked.mergedHandler?.());
    await waitFor(() => expect(mocked.api.mock.calls.length).toBeGreaterThan(before));
  });

  it("push posts default forceWithLease false and expected localSha", async () => {
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await waitFor(() => expect(result.current.pushStatus).not.toBeNull());
    await act(async () => { await result.current.push(); });
    expect(mocked.api).toHaveBeenCalledWith("/projects/p1/merge-advance/push-origin", expect.objectContaining({ body: JSON.stringify({ forceWithLease: false, expectedLocalSha: "localsha" }) }));
  });

  it("setForceWithLease persists and updates push payload", async () => {
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await waitFor(() => expect(result.current.pushStatus).not.toBeNull());
    act(() => result.current.setForceWithLease(true));
    expect(window.sessionStorage.getItem("kb:p1:merge-advance-force-with-lease")).toBe("1");
    await act(async () => { await result.current.push(); });
    expect(mocked.api).toHaveBeenCalledWith("/projects/p1/merge-advance/push-origin", expect.objectContaining({ body: JSON.stringify({ forceWithLease: true, expectedLocalSha: "localsha" }) }));
  });

  it("successful push auto clears pushState", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await act(async () => { await result.current.push(); });
    expect(result.current.pushState).toBe("ok");
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.pushState).toBe("idle");
  });

  it("rejected-non-ff and merge-locked outcomes do not change pullState", async () => {
    mocked.api.mockImplementationOnce(async () => eventPayload)
      .mockImplementationOnce(async () => pushStatus)
      .mockImplementationOnce(async () => ({ ok: false, outcome: "rejected-non-ff", message: "Remote diverged", stderrPreview: "[rejected]" }))
      .mockImplementationOnce(async () => eventPayload)
      .mockImplementationOnce(async () => pushStatus)
      .mockImplementationOnce(async () => ({ ok: false, outcome: "merge-locked", message: "locked" }));
    const first = renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await waitFor(() => expect(first.result.current.pushStatus).not.toBeNull());
    await act(async () => { await first.result.current.push(); });
    expect(first.result.current.pushState).toMatchObject({
      outcome: "rejected-non-ff",
      error: "Remote diverged",
      stderr: "[rejected]",
    });
    expect(first.result.current.pullState).toBe("idle");

    const second = renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await waitFor(() => expect(second.result.current.pushStatus).not.toBeNull());
    await act(async () => { await second.result.current.push(); });
    expect(second.result.current.pushState).toMatchObject({ outcome: "merge-locked" });
    expect(second.result.current.pullState).toBe("idle");
  });

  it("maps degenerate failed ok outcome to failed", async () => {
    mocked.api.mockImplementationOnce(async () => eventPayload)
      .mockImplementationOnce(async () => pushStatus)
      .mockImplementationOnce(async () => ({ ok: false, outcome: "ok", message: "unexpected" }));

    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await waitFor(() => expect(result.current.pushStatus).not.toBeNull());
    await act(async () => { await result.current.push(); });

    expect(result.current.pushState).toMatchObject({
      outcome: "failed",
      error: "unexpected",
    });
  });

  it("does not poll on a timer", async () => {
    vi.useFakeTimers();
    renderHook(() => useMergeAdvanceNotice({ projectId: "p1" }));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const initialCalls = mocked.api.mock.calls.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(mocked.api.mock.calls.length).toBe(initialCalls);
  });

  it("pull posts to /git/pull and dismisses on clean outcome", async () => {
    const pullEventPayload = { events: [{ ...eventPayload.events[0], toSha: "clean12345" }] };
    mocked.api.mockImplementation(async (path: unknown) => {
      const target = toPath(path);
      if (target.includes("merge-advance-events")) return pullEventPayload;
      if (target.includes("push-status")) return pushStatus;
      if (target.includes("/git/pull")) return { kind: "pull-clean", toSha: "clean12345" };
      return { ok: true, outcome: "ok", localSha: "localsha", remoteSha: "localsha" };
    });
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1-pull-clean" }));
    await waitFor(() => expect(result.current.notice).toBeDefined());
    await act(async () => { await result.current.pull(); });
    expect(mocked.api.mock.calls.some((call) => toPath(call[0]).includes("/git/pull"))).toBe(true);
    expect(result.current.conflictState).toBeNull();
  });

  it("dismiss() actually removes the banner — dismissedShas filter is applied in the notice memo", async () => {
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1-dismiss" }));
    await waitFor(() => expect(result.current.notice?.toSha).toBe("abcdef123456"));
    act(() => result.current.dismiss());
    await waitFor(() => expect(result.current.notice).toBeUndefined());
  });

  it("auto-sync success (clean-sync) for this user's worktree suppresses the banner", async () => {
    const handledPayload = {
      events: [{
        ...eventPayload.events[0],
        toSha: "auto-handled-1",
        autoSync: [{ worktreePath: "/repo", outcome: "clean-sync", mode: "stash-and-ff" }],
      }],
    };
    mocked.api.mockImplementation(async (path: string) => {
      if (String(path).includes("merge-advance-events")) return handledPayload;
      if (String(path).includes("push-status")) return pushStatus;
      return { ok: true };
    });
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1-auto-handled" }));
    await waitFor(() => expect(result.current.pushStatus?.localSha).toBe("localsha"));
    // Banner must NOT appear — auto-sync already brought the worktree forward.
    expect(result.current.notice).toBeUndefined();
  });

  it("auto-sync conflict (synced-with-pop-conflict) still surfaces the banner so the user can recover", async () => {
    const conflictPayload = {
      events: [{
        ...eventPayload.events[0],
        toSha: "auto-conflict-1",
        autoSync: [{
          worktreePath: "/repo",
          outcome: "synced-with-pop-conflict",
          mode: "stash-and-ff",
          patchPath: "/tmp/fusion-worktree-sync-abc/edits.patch",
          conflictedFiles: ["src/a.ts"],
        }],
      }],
    };
    mocked.api.mockImplementation(async (path: string) => {
      if (String(path).includes("merge-advance-events")) return conflictPayload;
      if (String(path).includes("push-status")) return pushStatus;
      return { ok: true };
    });
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1-auto-conflict" }));
    await waitFor(() => expect(result.current.notice).toBeDefined());
    expect(result.current.notice?.toSha).toBe("auto-conflict-1");
  });

  it("auto-sync success on a DIFFERENT worktree path does not suppress the banner for this user", async () => {
    // Two project-root checkouts on the same branch: auto-sync handled the
    // other one (/other-repo) but the current user is on /repo and still has
    // a stale checkout.
    const mixedPayload = {
      events: [{
        ...eventPayload.events[0],
        toSha: "mixed-1",
        autoSync: [{ worktreePath: "/other-repo", outcome: "clean-sync", mode: "stash-and-ff" }],
      }],
    };
    mocked.api.mockImplementation(async (path: string) => {
      if (String(path).includes("merge-advance-events")) return mixedPayload;
      if (String(path).includes("push-status")) return pushStatus;
      return { ok: true };
    });
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1-mixed" }));
    await waitFor(() => expect(result.current.notice).toBeDefined());
  });

  it("pull stash-conflict opens conflict state and preserves error visibility", async () => {
    const conflictEventPayload = { events: [{ ...eventPayload.events[0], toSha: "conflict12345" }] };
    mocked.api.mockImplementation(async (path: unknown) => {
      const target = toPath(path);
      if (target.includes("merge-advance-events")) return conflictEventPayload;
      if (target.includes("push-status")) return pushStatus;
      if (target.includes("/git/pull")) {
        return {
          kind: "stash-conflict",
          toSha: "conflict12345",
          stashSha: "stashsha",
          stashLabel: "fusion-auto",
          conflictedFiles: ["src/a.ts"],
          autostashOutcome: "failed",
        };
      }
      return pushStatus;
    });
    const { result } = renderHook(() => useMergeAdvanceNotice({ projectId: "p1-pull-conflict" }));
    await waitFor(() => expect(result.current.notice?.toSha).toBe("conflict12345"));
    await act(async () => { await result.current.pull(); });
    await waitFor(() => expect(result.current.conflictState).not.toBeNull());
    expect(result.current.conflictState).toEqual({
      stashSha: "stashsha",
      stashLabel: "fusion-auto",
      conflictedFiles: ["src/a.ts"],
      autostashOutcome: "failed",
    });
  });
});
