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
  it("expose Notes inline uniquement dans le dock Alpha desktop", async () => {
    expect(getVisibleOverflowViewEntries().map((entry) => entry.key)).not.toContain("notes");
    expect(getVisibleOverflowViewEntries({ hostMode: "standard" }).map((entry) => entry.key)).not.toContain("notes");

    const options = { hostMode: "alpha-desktop" as const };
    const entry = findOverflowViewEntry("notes", options);
    expect(entry?.testId).toBe("right-dock-tab-notes");
    expect(isOverflowViewEntryExpandable(entry, options)).toBe(false);
    const controller = {} as never;
    render(<>{entry?.render?.({ projectId: "project-notes", hostMode: "alpha-desktop", addToast: vi.fn(), notesController: controller, onOpenNote: vi.fn() })}</>);
    expect(await screen.findByTestId("mock-notes-view")).toHaveAttribute("data-compact", "true");
    expect(screen.getByTestId("mock-notes-view")).toHaveAttribute("data-list-only", "true");
    expect(screen.getByTestId("mock-notes-view")).toHaveAttribute("data-controller", "true");
    expect(screen.getByTestId("mock-notes-view")).toHaveAttribute("data-open-note", "true");
  });

  it("rejette une ancienne sélection Notes dans les hôtes standard", () => {
    localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "notes");
    expect(readStoredRightDockView({})).toBe("files");
    expect(readStoredRightDockView({ hostMode: "standard" })).toBe("files");
    expect(readStoredRightDockView({ hostMode: "alpha-desktop" })).toBe("notes");
  });
});
