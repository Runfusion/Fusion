import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { ActivityLogModal } from "../ActivityLogModal";
import { ScriptsModal } from "../ScriptsModal";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import type { Task } from "@fusion/core";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 closes the window-tool family with real mounts: History and Scripts must own exactly one canonical header
zone, keep their exit inside it, and bound their body in the content zone on both the desktop window presentation
and the phone sheet. The embedded dock presentation keeps its host's exit as the only one.
*/

vi.mock("../../api", () => ({
  fetchActivityFeed: vi.fn(async () => ({ entries: [], hasMore: false })),
  fetchActivityLog: vi.fn(async () => []),
  clearActivityLog: vi.fn(async () => undefined),
  fetchScripts: vi.fn(async () => ({})),
  normalizeScriptCatalog: (value: Record<string, string>) =>
    Object.entries(value).map(([name, command]) => ({ name, command })),
  addScript: vi.fn(async () => ({ name: "new-script", command: "echo hello" })),
  removeScript: vi.fn(async () => undefined),
}));

const originalWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && (query.includes("max-width") || query.includes("max-height")),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  document.documentElement.dataset.viewportMode = mode;
}

const tasks: Task[] = [{ id: "FN-001", title: "Standardize the dashboard", column: "todo" }] as Task[];

function headerOf(root: HTMLElement): HTMLElement {
  const headers = root.querySelectorAll<HTMLElement>(".view-header");
  expect(headers).toHaveLength(1);
  return headers[0];
}

describe("FN-379 standardized window tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    delete document.documentElement.dataset.viewportMode;
  });

  it.each(["desktop", "mobile"] as const)("keeps History on one canonical header and bounded content (%s)", async (mode) => {
    setViewport(mode);
    const onClose = vi.fn();
    render(
      <ViewLayoutProvider projectId="project-window-tools">
        <ActivityLogModal isOpen onClose={onClose} tasks={tasks} />
      </ViewLayoutProvider>,
    );

    const modal = await screen.findByTestId("activity-log-modal");
    const header = headerOf(modal);
    expect(within(header).getByText("Activity Log")).toBeInTheDocument();
    // The filters and the refresh entry stay inside the single header, not in a second local row.
    expect(header.querySelector(".activity-log-actions")).toBeTruthy();
    expect(within(header).getByTestId("activity-refresh")).toBeInTheDocument();
    // Exactly one exit, built by the canonical primitive.
    const closes = modal.querySelectorAll(".modal-close");
    expect(closes).toHaveLength(1);
    expect(header.contains(closes[0])).toBe(true);
    // The list is bounded by the shared content zone rather than an ad-hoc scroller.
    const content = screen.getByTestId("activity-log-content");
    expect(content.getAttribute("data-view-layout-zone")).toBe("content");
    expect(header.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lets the embedded History host own the only exit", async () => {
    render(
      <ViewLayoutProvider projectId="project-window-tools">
        <ActivityLogModal isOpen onClose={vi.fn()} tasks={tasks} presentation="embedded" />
      </ViewLayoutProvider>,
    );

    const modal = await screen.findByTestId("activity-log-modal");
    expect(headerOf(modal)).toBeInTheDocument();
    expect(modal.querySelectorAll(".modal-close")).toHaveLength(0);
  });

  it.each(["desktop", "mobile"] as const)("keeps Scripts on one canonical header and bounded content (%s)", async (mode) => {
    setViewport(mode);
    render(
      <ViewLayoutProvider projectId="project-window-tools">
        <ScriptsModal isOpen onClose={vi.fn()} addToast={vi.fn()} />
      </ViewLayoutProvider>,
    );

    const window_ = await screen.findByTestId("floating-window-scripts");
    const header = headerOf(window_);
    expect(within(header).getByText("Scripts")).toBeInTheDocument();
    const closes = window_.querySelectorAll(".modal-close");
    expect(closes).toHaveLength(1);
    expect(header.contains(closes[0])).toBe(true);

    const content = window_.querySelector('[data-view-layout-zone="content"]');
    expect(content).toBeTruthy();
    await waitFor(() => expect(within(content as HTMLElement).getByTestId("add-script-btn")).toBeInTheDocument());
    expect(header.contains(content as HTMLElement)).toBe(false);
  });
});
