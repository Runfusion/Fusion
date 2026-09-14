// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QualityDashboardView } from "../dashboard-view";

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
FN-379 proves the Quality destination inside its own runner: a read-only run collection paints exactly one
cooperative header on desktop and on a phone, and never invents a creation entry it cannot honour.
*/

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch() {
  const fetchMock = vi.fn(async () => jsonResponse({ runs: [], settings: {}, artifacts: [] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setViewport(mode: "desktop" | "mobile") {
  document.documentElement.dataset.viewportMode = mode;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
}

const context = { projectId: "p-quality", tasks: [], workflowSteps: [], openTaskDetail: vi.fn(), addToast: vi.fn() } as never;

describe("Quality standardized view layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.viewportMode;
  });

  it("keeps one cooperative header without a creation entry on desktop", async () => {
    const fetchMock = installFetch();
    render(<QualityDashboardView context={context} />);

    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
    expect(document.querySelectorAll(".view-action-button--create")).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("keeps exactly one header on a phone", async () => {
    installFetch();
    setViewport("mobile");
    render(<QualityDashboardView context={context} />);

    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
  });
});
