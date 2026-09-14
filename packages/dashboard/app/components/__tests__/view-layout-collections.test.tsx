import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotesView } from "../NotesView";

function notesController() {
  const note = { id: "note-1", title: "Architecture", updatedAt: "2026-01-01T00:00:00Z" };
  return {
    notes: [note], selected: undefined, pendingSelectedId: undefined,
    draftTitle: "", draftContent: "", dirty: false, saving: false, loading: false,
    error: null, conflict: null, failedSelectionId: null, errorOperation: null, search: "",
    setSearch: vi.fn(), loadList: vi.fn(), select: vi.fn(), create: vi.fn(), remove: vi.fn(),
    save: vi.fn(), reload: vi.fn(), overwrite: vi.fn(), clearSelection: vi.fn(),
    setDraftTitle: vi.fn(), setDraftContent: vi.fn(),
  } as never;
}

describe("shared collection layout migrations", () => {
  it("keeps Notes list ownership in ViewSidebar and routes selection through its existing controller", () => {
    const controller = notesController();
    render(<NotesView projectId="p-1" controller={controller} />);
    expect(screen.getByRole("complementary", { name: "Notes list" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Architecture/ }));
    expect((controller as unknown as { select: ReturnType<typeof vi.fn> }).select).toHaveBeenCalledWith("note-1");
  });

  it("uses the canonical header create action only for the writable Notes collection", () => {
    render(<NotesView projectId="p-1" controller={notesController()} />);
    const create = screen.getByRole("button", { name: "New note" });
    expect(create).toHaveClass("view-action-button--create");
  });
});
