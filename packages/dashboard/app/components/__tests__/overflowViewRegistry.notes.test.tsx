import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findOverflowViewEntry, getVisibleOverflowViewEntries, isOverflowViewEntryExpandable } from "../overflowViewRegistry";
import { readStoredRightDockView, RIGHT_DOCK_VIEW_STORAGE_KEY } from "../RightDock";

vi.mock("../NotesView", () => ({
  NotesView: ({ projectId, compact, listOnly, controller, onOpenNote }: { projectId?: string; compact?: boolean; listOnly?: boolean; controller?: unknown; onOpenNote?: unknown }) => (
    <div data-testid="mock-notes-view" data-project-id={projectId} data-compact={String(compact)} data-list-only={String(listOnly)} data-controller={String(Boolean(controller))} data-open-note={String(typeof onOpenNote === "function")} />
  ),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("overflowViewRegistry Notes entry", () => {
  /*
   * FN-426: the dock is now an explicit project opt-in rather than an always-present shell surface, so its Notes
   * shortcut is offered on every host that can show the dock. The desktop-only gate existed to stop a stale stored
   * selection creating a hidden Notes owner in a dock nobody chose; the canonical Notes list is the header popover.
   */
  it("expose Notes inline compacte sur tablette comme sur ordinateur", async () => {
    expect(getVisibleOverflowViewEntries().map((entry) => entry.key)).toContain("notes");
    expect(getVisibleOverflowViewEntries({ hostMode: "standard" }).map((entry) => entry.key)).toContain("notes");

    const options = { hostMode: "desktop" as const };
    const entry = findOverflowViewEntry("notes", options);
    expect(entry?.testId).toBe("right-dock-tab-notes");
    expect(isOverflowViewEntryExpandable(entry, options)).toBe(false);
    const controller = {} as never;
    render(<>{entry?.render?.({ projectId: "project-notes", hostMode: "desktop", addToast: vi.fn(), notesController: controller, onOpenNote: vi.fn() })}</>);
    expect(await screen.findByTestId("mock-notes-view")).toHaveAttribute("data-compact", "true");
    expect(screen.getByTestId("mock-notes-view")).toHaveAttribute("data-list-only", "true");
    expect(screen.getByTestId("mock-notes-view")).toHaveAttribute("data-controller", "true");
    expect(screen.getByTestId("mock-notes-view")).toHaveAttribute("data-open-note", "true");
  });

  /*
   * FN-426: a selection persisted before the tools moved out (`git-manager`, `activity-log`, `secrets`,
   * `pull-requests`, `devserver`, `plugin:*`) is no longer a visible tool, so the dock falls back to Files rather than
   * showing an empty panel. Those tools are reachable from their new hosts, not from here.
   */
  it.each(["git-manager", "activity-log", "secrets", "pull-requests", "devserver", "plugin:plugin-a:tools"])(
    "retombe sur Files pour une ancienne sélection %s",
    (stored) => {
      localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, stored);
      expect(readStoredRightDockView({})).toBe("files");
      expect(readStoredRightDockView({ hostMode: "desktop" })).toBe("files");
    },
  );

  it("conserve une sélection Notes valide sur les deux hôtes", () => {
    localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "notes");
    expect(readStoredRightDockView({ hostMode: "standard" })).toBe("notes");
    expect(readStoredRightDockView({ hostMode: "desktop" })).toBe("notes");
  });
});
