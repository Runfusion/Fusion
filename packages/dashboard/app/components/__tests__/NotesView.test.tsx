import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../api/client/client";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { NotesView } from "../NotesView";

const api = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock("../../api/notes", () => api);
vi.mock("../FileEditor", () => ({ FileEditor: ({ content, onChange }: any) => <textarea aria-label="Markdown editor" value={content} onChange={(event) => onChange(event.target.value)} /> }));

const note = { id: "n", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const originalInnerWidth = window.innerWidth;
const renderNotes = () => render(<ConfirmDialogProvider><NotesView projectId="p" /></ConfirmDialogProvider>);

async function openNote() {
  renderNotes();
  const item = await screen.findByRole("button", { name: /Commande/ });
  fireEvent.click(item);
  await screen.findByLabelText("Note title");
}

describe("NotesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchNotes.mockResolvedValue({ notes: [note] });
    api.fetchNote.mockResolvedValue(note);
    api.createNote.mockResolvedValue(note);
    api.updateNote.mockResolvedValue({ ...note, revision: 2 });
    api.deleteNote.mockResolvedValue(undefined);
  });
  afterEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth }); window.dispatchEvent(new Event("resize")); });

  it("renders an accessible empty state and creates the first note through the production hook", async () => {
    api.fetchNotes.mockResolvedValue({ notes: [] });
    renderNotes();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    const create = await screen.findByRole("button", { name: "Create your first note" });
    fireEvent.click(create);
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith("p", { title: "Nouvelle note", content: "" }));
    expect(await screen.findByLabelText("Note title")).toHaveValue(note.title);
  });

  it("edits title/content and saves through buttons and the keyboard shortcut", async () => {
    await openNote();
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Logs" } });
    fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value: "```\nlog\n```" } });
    api.updateNote.mockResolvedValueOnce({ ...note, title: "Logs", content: "```\nlog\n```", revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledWith("p", note.id, { title: "Logs", content: "```\nlog\n```", expectedRevision: 1 }));

    fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value: "commande suivante" } });
    api.updateNote.mockResolvedValueOnce({ ...note, title: "Logs", content: "commande suivante", revision: 3 });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(2));
  });

  it("requires confirmation before deleting and supports cancellation", async () => {
    await openNote();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    let dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteNote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(api.deleteNote).toHaveBeenCalledWith("p", note.id, note.revision));
  });

  it("keeps the local draft visible on conflict and overwrites only after an explicit action", async () => {
    await openNote();
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Local" } });
    fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value: "logs locaux" } });
    api.updateNote.mockRejectedValueOnce(new ApiRequestError("conflict", 409, { code: "NOTE_REVISION_CONFLICT" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    const conflict = await screen.findByRole("alert");
    expect(conflict).toHaveTextContent("Your draft is preserved");
    expect(screen.getByLabelText("Note title")).toHaveValue("Local");
    expect(screen.getByLabelText("Markdown editor")).toHaveValue("logs locaux");

    api.fetchNote.mockResolvedValueOnce({ ...note, content: "version serveur", revision: 2 });
    api.updateNote.mockResolvedValueOnce({ ...note, title: "Local", content: "logs locaux", revision: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Overwrite with my draft" }));
    await waitFor(() => expect(api.updateNote).toHaveBeenLastCalledWith("p", note.id, { title: "Local", content: "logs locaux", expectedRevision: 2 }));
  });

  it("offers an accessible mobile back target and confirms abandoning a draft", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    await openNote();
    fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value: "brouillon mobile" } });
    fireEvent.click(screen.getByLabelText("Back"));
    const dialog = await screen.findByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Commande/ })).toBeInTheDocument();
  });
});
