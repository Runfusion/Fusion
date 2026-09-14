import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CompoundEngineeringView } from "../CompoundEngineeringView.js";

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
FN-379 proves the Compound Engineering destination inside its own runner: it paints exactly one cooperative
header on desktop and on a phone, invents no creation entry for a run-driven view, and starts no session merely
because the destination mounted.
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
  const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ groups: [], sessions: [] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setViewport(mode: "desktop" | "mobile") {
  document.documentElement.dataset.viewportMode = mode;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
}

describe("Compound Engineering standardized view layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.viewportMode;
  });

  it("keeps one cooperative header and mutates nothing on mount", async () => {
    const fetchMock = installFetch();
    render(<CompoundEngineeringView projectId="p-ce" enabledOverride={false} />);

    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
    expect(document.querySelectorAll(".view-action-button--create")).toHaveLength(0);
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });

  it("keeps exactly one header on a phone without a separate back row", async () => {
    installFetch();
    setViewport("mobile");
    render(<CompoundEngineeringView projectId="p-ce" enabledOverride={false} />);

    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();
  });
});
