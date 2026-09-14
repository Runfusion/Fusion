import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { DependencyGraphDashboardView } from "../dashboard-view";

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
FN-379 classifies the dependency graph as a HOST-titled destination: the canvas body must never build a competing
cooperative header, on desktop or on a phone, so the framing host stays the sole title owner.
*/

function setViewport(mode: "desktop" | "mobile") {
  document.documentElement.dataset.viewportMode = mode;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
}

const context = { projectId: "p-graph", tasks: [], workflowSteps: [], openTaskDetail: vi.fn() } as never;

describe("Dependency graph standardized view layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport("desktop");
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.viewportMode;
  });

  it("builds no competing header on desktop", async () => {
    render(<DependencyGraphDashboardView context={context} />);
    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(0));
  });

  it("builds no competing header on a phone either", async () => {
    setViewport("mobile");
    render(<DependencyGraphDashboardView context={context} />);
    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(0));
  });
});
