import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { LinearImportView } from "../LinearImportView.js";

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
FN-379 proves the Linear import destination inside its own runner: one cooperative header on desktop and on a
phone, and mounting the destination imports nothing — a layout change may never trigger a business mutation.
*/

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true, authenticated: false, configured: false, issues: [] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setViewport(mode: "desktop" | "mobile") {
  document.documentElement.dataset.viewportMode = mode;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
}

const context = { projectId: "p-linear" } as never;

describe("Linear import standardized view layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.viewportMode;
  });

  it("keeps one cooperative header and imports nothing on mount", async () => {
    const fetchMock = installFetch();
    render(<LinearImportView context={context} />);

    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("keeps exactly one header on a phone", async () => {
    installFetch();
    setViewport("mobile");
    render(<LinearImportView context={context} />);

    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
  });
});
