import { useRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RuntimeFallbackBadge } from "../RuntimeFallbackBadge";
import { ToastProvider, useToast } from "../../hooks/useToast";
import type { TaskRuntimeFallbackResponse } from "../../api/legacy";

const legacyMocks = vi.hoisted(() => ({
  fetchTaskRuntimeFallback: vi.fn(),
}));

vi.mock("../../api/legacy", () => legacyMocks);

// Toasts auto-dismiss after 4s (useToast's internal timer). To assert "fired
// exactly once" across a longer window we must count every toast ever
// appended, not just the currently-visible set, so track full history here.
function ToastPeek() {
  const { toasts } = useToast();
  const historyRef = useRef<typeof toasts>([]);
  const seenIds = useRef(new Set<number>());
  for (const toast of toasts) {
    if (!seenIds.current.has(toast.id)) {
      seenIds.current.add(toast.id);
      historyRef.current.push(toast);
    }
  }
  return (
    <div data-testid="toast-peek">
      {historyRef.current.map((t) => (
        <div key={t.id} data-testid="toast-entry" data-type={t.type}>{t.message}</div>
      ))}
    </div>
  );
}

function renderBadge(taskId = "FN-100", isInViewport = true) {
  return render(
    <ToastProvider>
      <RuntimeFallbackBadge taskId={taskId} isInViewport={isInViewport} projectId="proj-1" />
      <ToastPeek />
    </ToastProvider>,
  );
}

const noEvent: TaskRuntimeFallbackResponse = {
  taskId: "FN-100",
  hasEvent: false,
  wasConfigured: null,
  runtimeHint: null,
  reason: null,
  eventId: null,
  timestamp: null,
  showFallbackBadge: false,
};

const configuredOk: TaskRuntimeFallbackResponse = {
  ...noEvent,
  hasEvent: true,
  wasConfigured: true,
  runtimeHint: "hermes",
  eventId: "audit-ok",
  timestamp: "2026-07-08T00:00:00.000Z",
  showFallbackBadge: false,
};

const fallbackBlankHint: TaskRuntimeFallbackResponse = {
  ...noEvent,
  hasEvent: true,
  wasConfigured: false,
  runtimeHint: null,
  eventId: "audit-blank",
  timestamp: "2026-07-08T00:00:00.000Z",
  showFallbackBadge: false,
};

const fallbackWithHint: TaskRuntimeFallbackResponse = {
  taskId: "FN-100",
  hasEvent: true,
  wasConfigured: false,
  runtimeHint: "hermes",
  reason: "not_found",
  eventId: "audit-fallback-1",
  timestamp: "2026-07-08T00:00:00.000Z",
  showFallbackBadge: true,
};

describe("RuntimeFallbackBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    legacyMocks.fetchTaskRuntimeFallback.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when no session:runtime-resolved event exists yet", async () => {
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(noEvent);
    renderBadge();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("runtime-fallback-badge")).toBeNull();
  });

  it("renders nothing when the most recent event has wasConfigured=true", async () => {
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(configuredOk);
    renderBadge();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("runtime-fallback-badge")).toBeNull();
  });

  it("renders nothing when wasConfigured=false but runtimeHint is blank/absent", async () => {
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(fallbackBlankHint);
    renderBadge();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("runtime-fallback-badge")).toBeNull();
  });

  it("renders the badge when wasConfigured=false and runtimeHint is non-empty", async () => {
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(fallbackWithHint);
    renderBadge();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const badge = screen.getByTestId("runtime-fallback-badge");
    expect(badge.textContent).toContain("hermes");
    expect(badge.textContent).toContain("unavailable");
    expect(badge.getAttribute("data-runtime-hint")).toBe("hermes");
    expect(badge.getAttribute("data-runtime-fallback-reason")).toBe("not_found");
  });

  it("does not resurrect the badge when a stale wasConfigured=false event is superseded by a newer success", async () => {
    // Simulates: latest-event endpoint already reflects only the newest event,
    // so a superseded older fallback never reaches the component as `showFallbackBadge`.
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(configuredOk);
    renderBadge();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("runtime-fallback-badge")).toBeNull();
  });

  it("fires a toast exactly once for a newly-observed fallback session, not on every poll", async () => {
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(fallbackWithHint);
    renderBadge();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getAllByTestId("toast-entry")).toHaveLength(1);
    expect(screen.getAllByTestId("toast-entry")[0].textContent).toContain("hermes");

    // Advance past several poll intervals with the *same* event still being the latest;
    // the toast must not fire again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getAllByTestId("toast-entry")).toHaveLength(1);
  });

  it("does not poll (and renders nothing) when isInViewport is false", async () => {
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(fallbackWithHint);
    renderBadge("FN-100", false);

    await act(async () => {
      await Promise.resolve();
    });

    expect(legacyMocks.fetchTaskRuntimeFallback).not.toHaveBeenCalled();
    expect(screen.queryByTestId("runtime-fallback-badge")).toBeNull();
  });
});

describe("RuntimeFallbackBadge — mobile breakpoint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    legacyMocks.fetchTaskRuntimeFallback.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockMobileViewport() {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 812, configurable: true });
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn() });
    }
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  it("still renders the badge with its message and data attributes at mobile viewport width", async () => {
    mockMobileViewport();
    legacyMocks.fetchTaskRuntimeFallback.mockResolvedValue(fallbackWithHint);
    renderBadge();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const badge = screen.getByTestId("runtime-fallback-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("hermes");
    expect(badge.className).toContain("card-runtime-fallback-badge");
  });
});
