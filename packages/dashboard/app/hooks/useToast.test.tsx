import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, act, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "./useToast";
import type { ReactNode } from "react";

/**
 * Toast hook tests
 *
 * Tests for the Toast context provider and useToast hook.
 * Note: The current implementation does not clean up setTimeout timers
 * when the provider unmounts, which could lead to memory leaks.
 */

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <ToastProvider>{children}</ToastProvider>;
  };
}

describe("ToastProvider", () => {
  it("renders children correctly", () => {
    const { container } = render(
      <ToastProvider>
        <div data-testid="child">Test Child</div>
      </ToastProvider>
    );

    expect(screen.getByTestId("child")).toBeDefined();
    expect(container.textContent).toContain("Test Child");
  });
});

describe("useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws error when used outside provider", () => {
    // Suppress console.error for expected error
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      renderHook(() => useToast());
    }).toThrow("useToast must be used within ToastProvider");

    consoleSpy.mockRestore();
  });

  it("returns correct context value within provider", () => {
    const { result } = renderHook(() => useToast(), {
      wrapper: createWrapper(),
    });

    expect(result.current).toHaveProperty("toasts");
    expect(result.current).toHaveProperty("addToast");
    expect(result.current).toHaveProperty("removeToast");
    expect(typeof result.current.addToast).toBe("function");
    expect(typeof result.current.removeToast).toBe("function");
  });

  it("`toasts` array is initially empty", () => {
    const { result } = renderHook(() => useToast(), {
      wrapper: createWrapper(),
    });

    expect(result.current.toasts).toEqual([]);
  });

describe("addToast", () => {
    it("adds a toast to the list with correct message and type", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Test message", "success");
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].message).toBe("Test message");
      expect(result.current.toasts[0].type).toBe("success");
    });

    it("auto-assigns unique incrementing IDs starting from 0", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("First", "info");
        result.current.addToast("Second", "info");
        result.current.addToast("Third", "info");
      });

      expect(result.current.toasts[0].id).toBe(0);
      expect(result.current.toasts[1].id).toBe(1);
      expect(result.current.toasts[2].id).toBe(2);
    });

    it("defaults type to 'info' when not specified", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Test message");
      });

      expect(result.current.toasts[0].type).toBe("info");
    });

    it("accepts 'success' type", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Success!", "success");
      });

      expect(result.current.toasts[0].type).toBe("success");
    });

    it("accepts 'error' type", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Error!", "error");
      });

      expect(result.current.toasts[0].type).toBe("error");
    });

    it("accepts 'info' type explicitly", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Info", "info");
      });

      expect(result.current.toasts[0].type).toBe("info");
    });

    it("toasts auto-remove after 4000ms", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Test message");
      });

      expect(result.current.toasts).toHaveLength(1);

      // Advance time by 4000ms
      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(result.current.toasts).toHaveLength(0);
    });

    it("toasts remain visible before 4000ms expires", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Test message");
      });

      // Advance time by 3999ms - toast should still be there
      act(() => {
        vi.advanceTimersByTime(3999);
      });

      expect(result.current.toasts).toHaveLength(1);
    });
  });

describe("removeToast", () => {
    it("manually removes a specific toast by ID", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("First", "info");
        result.current.addToast("Second", "info");
        result.current.addToast("Third", "info");
      });

      expect(result.current.toasts).toHaveLength(3);

      // Remove the second toast (ID: 1)
      act(() => {
        result.current.removeToast(1);
      });

      expect(result.current.toasts).toHaveLength(2);
      expect(result.current.toasts.map((t) => t.id)).toEqual([0, 2]);
    });

    it("does nothing when removing non-existent toast ID", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Test", "info");
      });

      expect(result.current.toasts).toHaveLength(1);

      // Try to remove non-existent ID
      act(() => {
        result.current.removeToast(999);
      });

      // Toast should still be there
      expect(result.current.toasts).toHaveLength(1);
    });
  });

describe("multiple toasts", () => {
    it("can exist simultaneously", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("First", "info");
        result.current.addToast("Second", "success");
        result.current.addToast("Third", "error");
      });

      expect(result.current.toasts).toHaveLength(3);
      expect(result.current.toasts[0].message).toBe("First");
      expect(result.current.toasts[1].message).toBe("Second");
      expect(result.current.toasts[2].message).toBe("Third");
    });

    it("auto-remove independently based on their creation time", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      // Add first toast at time 0
      act(() => {
        result.current.addToast("First", "info");
      });

      // Advance 2000ms and add second toast
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      act(() => {
        result.current.addToast("Second", "info");
      });

      expect(result.current.toasts).toHaveLength(2);

      // Advance 2000ms more (total 4000ms from first toast)
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      // First toast should be gone, second still there
      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].message).toBe("Second");

      // Advance 2000ms more (total 4000ms from second toast)
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      // Both should be gone
      expect(result.current.toasts).toHaveLength(0);
    });

    it("have unique IDs even with same message", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Same message", "info");
        result.current.addToast("Same message", "info");
        result.current.addToast("Same message", "info");
      });

      const ids = result.current.toasts.map((t) => t.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(3); // All IDs should be unique
    });
  });

describe("timer cleanup on unmount (future improvement)", () => {
    // Note: The current implementation does not clean up setTimeout timers
    // when the provider unmounts. This is a known limitation that could lead
    // to memory leaks and React warnings about state updates on unmounted
    // components. The following test documents the expected behavior if this
    // is ever fixed in the future.

    it.skip("should clear pending timers when provider unmounts (not currently implemented)", () => {
      // This test is skipped because the current implementation does not
      // store timer references for cleanup. To implement this properly,
      // the addToast function would need to:
      // 1. Store setTimeout handle in a ref
      // 2. Return cleanup function or use useEffect cleanup

      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      const { result, unmount } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("Test");
      });

      unmount();

      // This expectation would fail with current implementation
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it("continues auto-removing toasts after one is removed early", () => {
      const { result } = renderHook(() => useToast(), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.addToast("First", "info");
        result.current.addToast("Second", "info");
      });

      // Remove first toast immediately
      act(() => {
        result.current.removeToast(0);
      });

      expect(result.current.toasts).toHaveLength(1);
      expect(result.current.toasts[0].message).toBe("Second");

      // Advance full 4000ms from when second toast was created
      act(() => {
        vi.advanceTimersByTime(4000);
      });

      // Second toast should still auto-remove
      expect(result.current.toasts).toHaveLength(0);
    });
  });
});
