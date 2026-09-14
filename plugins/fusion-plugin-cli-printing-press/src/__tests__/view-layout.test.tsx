// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { CliPrintingPressManageView } from "../manage-view";
import { CliPrintingPressWizardView } from "../dashboard-view";

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
FN-379 classifies the Printing Press pair by title owner: Manage paints exactly one cooperative header on desktop
and on a phone, while the wizard leaves its title to the framing host and persists nothing merely by mounting.
*/

vi.mock("lucide-react", () => ({
  List: () => null,
  Pencil: () => null,
  RefreshCw: () => null,
  Trash2: () => null,
  Play: () => null,
  CheckCircle2: () => null,
  AlertTriangle: () => null,
}));

function setViewport(mode: "desktop" | "mobile") {
  document.documentElement.dataset.viewportMode = mode;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
}

function installFetch() {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Printing Press standardized view layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.viewportMode;
  });

  it("keeps Manage on one cooperative header for an empty collection", async () => {
    installFetch();
    render(<CliPrintingPressManageView />);
    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
  });

  it("keeps Manage single-headed on a phone", async () => {
    installFetch();
    setViewport("mobile");
    render(<CliPrintingPressManageView />);
    await waitFor(() => expect(document.querySelectorAll(".view-header")).toHaveLength(1));
  });

  it("leaves the wizard title to its framing host and saves nothing on mount", async () => {
    const fetchMock = installFetch();
    render(<CliPrintingPressWizardView />);
    await waitFor(() => expect(document.querySelector(".cli-press-wizard")).toBeTruthy());
    expect(document.querySelectorAll(".view-header")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
