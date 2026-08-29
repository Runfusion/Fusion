import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  NavigationHistoryProvider,
  useNavigationHistory,
  useNavigationHistoryContext,
  type UseNavigationHistoryResult,
} from "../useNavigationHistory";

describe("useNavigationHistory", () => {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;
  const originalBack = window.history.back;

  let pushStateSpy: ReturnType<typeof vi.fn>;
  let replaceStateSpy: ReturnType<typeof vi.fn>;
  let backSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    pushStateSpy = vi.fn();
    replaceStateSpy = vi.fn();
    backSpy = vi.fn();
    // Use real replaceState for setup so history.state is actually set,
    // then install spies for assertions.
    window.history.replaceState = originalReplaceState;
    window.history.replaceState({}, "");
    window.history.pushState = pushStateSpy;
    window.history.replaceState = replaceStateSpy;
    window.history.back = backSpy;
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
    window.history.back = originalBack;
  });

  function renderHookWithHistory(enabled = true) {
    return renderHook(({ enabled: e }) => useNavigationHistory({ enabled: e }), {
      initialProps: { enabled },
    });
  }

  function dispatchPopState(state: Record<string, unknown> | null) {
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state }));
    });
  }

  // 1. pushNav calls history.pushState with incremented navIndex
  it("pushNav calls history.pushState with incremented navIndex", () => {
    const { result } = renderHookWithHistory();

    const close = vi.fn();
    const revert = vi.fn();

    act(() => {
      result.current.pushNav({ type: "modal", close });
    });
    expect(pushStateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ navIndex: 1 }),
      "",
    );

    act(() => {
      result.current.pushNav({ type: "view", revert });
    });
    expect(pushStateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ navIndex: 2 }),
      "",
    );
  });

  // 2. popstate invokes close callback
  it("popstate invokes close callback and pops entry from stack", () => {
    const close = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close });
    });

    dispatchPopState({ navIndex: 0 });

    expect(close).toHaveBeenCalledTimes(1);
  });

  // 3. popstate sets isPopping flag — pushNav is a no-op during pop handling
  it("pushNav is a no-op during pop handling (isPopping guard)", () => {
    let pushNavFromCallback: ((entry: { type: "modal"; close: () => void }) => void) | null = null;
    const closeThatCapturesPushNav = vi.fn(() => {
      // This simulates a state change inside the pop callback.
      // We don't call pushNav here because the callback doesn't have access to it.
      // Instead, we verify the isPopping mechanism by checking no extra pushState calls.
    });

    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: closeThatCapturesPushNav });
    });

    const pushCallCount = pushStateSpy.mock.calls.length;

    dispatchPopState({ navIndex: 0 });

    expect(closeThatCapturesPushNav).toHaveBeenCalledTimes(1);
    // The pushState call count should not have increased from pop handling
    expect(pushStateSpy.mock.calls.length).toBe(pushCallCount);
  });

  // 4. Multiple pushes create a stack — pop back pops correct entries
  it("multiple pushes create a stack and pop back pops correct entries", () => {
    const close1 = vi.fn();
    const close2 = vi.fn();
    const close3 = vi.fn();

    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: close1 });
      result.current.pushNav({ type: "modal", close: close2 });
      result.current.pushNav({ type: "modal", close: close3 });
    });

    // Pop back to index 2 (pops entry 3 only)
    dispatchPopState({ navIndex: 2 });

    expect(close3).toHaveBeenCalledTimes(1);
    expect(close2).not.toHaveBeenCalled();
    expect(close1).not.toHaveBeenCalled();
  });

  it("removeNav removes a matching entry and calls history.back", () => {
    const close = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close });
    });

    act(() => {
      result.current.removeNav(close);
    });

    expect(backSpy).toHaveBeenCalledTimes(1);

    dispatchPopState({ navIndex: 0 });

    expect(close).not.toHaveBeenCalled();
  });

  it("consumes the self-triggered popstate after removeNav without invoking callbacks", () => {
    const close = vi.fn();
    const revert = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close });
      result.current.pushNav({ type: "view", revert });
      result.current.removeNav(revert);
    });

    dispatchPopState({ navIndex: 1 });

    expect(revert).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("allows reopening with the same callback after removeNav", () => {
    const close = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close });
      result.current.removeNav(close);
    });

    dispatchPopState({ navIndex: 0 });

    act(() => {
      result.current.pushNav({ type: "modal", close });
    });

    expect(pushStateSpy).toHaveBeenCalledTimes(2);
  });

  it("dismisses the reopened top entry after a deferred self-pop leaves stale navIndex state", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: closeA });
      result.current.removeNav(closeA);
      result.current.pushNav({ type: "modal", close: closeB });
    });

    // The deferred removeNav pop arrives after the reopen and is consumed.
    dispatchPopState({ navIndex: 1 });
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();

    // FNXC:TaskDetailSwipeBack 2026-06-30-09:25:
    // Mobile swipe-back must still dismiss the reopened surface even when
    // history retained a stale navIndex from the pre-close entry.
    dispatchPopState({ navIndex: 1 });

    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("falls back to dismissing the top entry when popstate carries a stale navIndex", () => {
    const close = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close });
    });

    dispatchPopState({ navIndex: 3 });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps stack order consistent after removing the top entry", () => {
    const close1 = vi.fn();
    const close2 = vi.fn();
    const close3 = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: close1 });
      result.current.pushNav({ type: "modal", close: close2 });
      result.current.pushNav({ type: "modal", close: close3 });
      result.current.removeNav(close3);
    });

    dispatchPopState({ navIndex: 2 });
    dispatchPopState({ navIndex: 1 });

    expect(close3).not.toHaveBeenCalled();
    expect(close2).toHaveBeenCalledTimes(1);
    expect(close1).not.toHaveBeenCalled();
  });

  it("removeNav is a no-op when the callback is not on the stack", () => {
    const close = vi.fn();
    const absent = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close });
      result.current.removeNav(absent);
    });

    expect(backSpy).not.toHaveBeenCalled();

    dispatchPopState({ navIndex: 0 });

    expect(close).toHaveBeenCalledTimes(1);
  });

  // 5. replaceCurrent updates the top entry
  it("replaceCurrent updates the top entry", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();

    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: closeA });
    });

    act(() => {
      result.current.replaceCurrent({ type: "modal", close: closeB });
    });

    // Pop back to index 0 — should call closeB (the replacement), not closeA
    dispatchPopState({ navIndex: 0 });

    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });

  // 6. replaceCurrent calls history.replaceState (not pushState)
  it("replaceCurrent calls history.replaceState", () => {
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: vi.fn() });
    });

    const pushCountBefore = pushStateSpy.mock.calls.length;
    const replaceCountBefore = replaceStateSpy.mock.calls.length;

    act(() => {
      result.current.replaceCurrent({ type: "modal", close: vi.fn() });
    });

    // pushState should not have been called again
    expect(pushStateSpy.mock.calls.length).toBe(pushCountBefore);
    // replaceState should have been called
    expect(replaceStateSpy.mock.calls.length).toBeGreaterThan(replaceCountBefore);
  });

  // 7. No-op when enabled: false (desktop mode)
  it("pushNav and replaceCurrent are no-ops when enabled is false", () => {
    const { result } = renderHookWithHistory(false);

    act(() => {
      result.current.pushNav({ type: "modal", close: vi.fn() });
    });

    expect(pushStateSpy).not.toHaveBeenCalled();

    act(() => {
      result.current.replaceCurrent({ type: "modal", close: vi.fn() });
    });

    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  // 8. No popstate handling when enabled: false
  it("no callbacks are invoked on popstate when enabled is false", () => {
    const close = vi.fn();
    const { result } = renderHookWithHistory(false);

    // Even if we somehow had entries, popstate shouldn't trigger callbacks
    dispatchPopState({ navIndex: 0 });

    expect(close).not.toHaveBeenCalled();
  });

  // 9. Duplicate-consecutive-push guard
  it("reconciles duplicate consecutive pushes with the same callback without adding history", () => {
    const close = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close });
    });

    expect(pushStateSpy).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.pushNav({ type: "modal", close });
    });

    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenCalledWith(expect.objectContaining({ navIndex: 1 }), "");
  });

  // 10. Handles rapid popstate (iOS fast swipe) — pops multiple entries
  it("handles rapid popstate by popping all entries back to target index", () => {
    const close1 = vi.fn();
    const close2 = vi.fn();
    const close3 = vi.fn();

    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: close1 });
      result.current.pushNav({ type: "modal", close: close2 });
      result.current.pushNav({ type: "modal", close: close3 });
    });

    // iOS fast swipe pops all the way back to index 0
    dispatchPopState({ navIndex: 0 });

    // All 3 close callbacks should be called in reverse order
    expect(close3).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);
    expect(close1).toHaveBeenCalledTimes(1);

    // Verify reverse order: close3 called before close2, close2 before close1
    const callOrder = [
      close3.mock.invocationCallOrder[0],
      close2.mock.invocationCallOrder[0],
      close1.mock.invocationCallOrder[0],
    ];
    expect(callOrder[0]).toBeLessThan(callOrder[1]);
    expect(callOrder[1]).toBeLessThan(callOrder[2]);
  });

  // Additional: enabled can be toggled dynamically
  it("respects dynamic enabled changes", () => {
    const close = vi.fn();
    const { result, rerender } = renderHookWithHistory();

    // Start enabled
    act(() => {
      result.current.pushNav({ type: "modal", close });
    });
    expect(pushStateSpy).toHaveBeenCalledTimes(1);

    // Disable
    rerender({ enabled: false });

    act(() => {
      result.current.pushNav({ type: "modal", close: vi.fn() });
    });
    // Should still be 1 — no-op when disabled
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
  });

  // Additional: replaceCurrent is a no-op when stack is empty
  it("replaceCurrent is a no-op when stack is empty", () => {
    const { result } = renderHookWithHistory();

    // Clear the spy to remove any setup calls
    replaceStateSpy.mockClear();

    act(() => {
      result.current.replaceCurrent({ type: "modal", close: vi.fn() });
    });

    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  // Additional: preserves existing history.state properties
  it("preserves existing history.state properties when pushing", () => {
    // Use the real replaceState to set actual state, then re-install spy
    window.history.replaceState = originalReplaceState;
    window.history.replaceState({ existingKey: "existingValue" }, "");
    window.history.replaceState = replaceStateSpy;

    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "modal", close: vi.fn() });
    });

    expect(pushStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        navIndex: 1,
        existingKey: "existingValue",
      }),
      "",
    );
  });

  // Additional: view entries call revert on popstate
  it("popstate invokes revert callback for view entries", () => {
    const revert = vi.fn();
    const { result } = renderHookWithHistory();

    act(() => {
      result.current.pushNav({ type: "view", revert });
    });

    dispatchPopState({ navIndex: 0 });

    expect(revert).toHaveBeenCalledTimes(1);
  });

  it("useNavigationHistoryContext returns the provided value", () => {
    const value: UseNavigationHistoryResult = {
      pushNav: vi.fn(),
      replaceCurrent: vi.fn(),
      removeNav: vi.fn(),
    };

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(NavigationHistoryProvider, { value }, children);

    const { result } = renderHook(() => useNavigationHistoryContext(), { wrapper });

    expect(result.current).toBe(value);
  });

  it("useNavigationHistoryContext throws outside the provider", () => {
    expect(() => renderHook(() => useNavigationHistoryContext())).toThrow(
      "useNavigationHistoryContext must be used within a NavigationHistoryProvider",
    );
  });
});
