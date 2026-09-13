import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { PoppedOutNoteWindows } from "../PoppedOutNoteWindows";

const api = vi.hoisted(() => ({ fetchNotes: vi.fn(), fetchNote: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn() }));
vi.mock("../../api/notes", () => api);
vi.mock("../FileEditor", () => ({ FileEditor: ({ content, onChange, filePath }: { content: string; onChange: (value: string) => void; filePath: string }) => <textarea aria-label={`editor-${filePath}`} value={content} onChange={(event) => onChange(event.target.value)} /> }));

const summary = (id: string, title: string) => ({ id, title, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const full = (id: string, title: string, content: string) => ({ ...summary(id, title), content, revision: 1 });

describe("PoppedOutNoteWindows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchNotes.mockResolvedValue({ notes: [] });
    api.fetchNote.mockImplementation(async (_projectId: string, id: string) => id === "n1" ? full("n1", "Première", "brouillon un") : full("n2", "Deuxième", "brouillon deux"));
    api.updateNote.mockImplementation(async (_projectId: string, id: string, input: { title: string; content: string }) => ({ ...full(id, input.title, input.content), revision: 2 }));
    api.deleteNote.mockResolvedValue(undefined);
  });

  it("monte deux éditeurs indépendants sans liste ni bouton Back", async () => {
    render(<ConfirmDialogProvider><PoppedOutNoteWindows
      entries={[
        { projectId: "p", note: summary("n1", "Première"), focusNonce: 1, cascadeSlot: 0 },
        { projectId: "p", note: summary("n2", "Deuxième"), focusNonce: 1, cascadeSlot: 1 },
      ]}
      projectId="p"
      addToast={vi.fn()}
      onClose={vi.fn()}
    /></ConfirmDialogProvider>);

    const first = await screen.findByLabelText("editor-n1.md");
    const second = await screen.findByLabelText("editor-n2.md");
    fireEvent.change(first, { target: { value: "modifié un" } });
    expect(first).toHaveValue("modifié un");
    expect(second).toHaveValue("brouillon deux");
    expect(document.querySelectorAll(".notes-list")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("conserve une erreur de chargement sans relancer la note en boucle", async () => {
    api.fetchNote.mockRejectedValueOnce(new Error("note indisponible"));
    render(<ConfirmDialogProvider><PoppedOutNoteWindows entries={[{ projectId: "p", note: summary("n1", "Première"), focusNonce: 1, cascadeSlot: 0 }]} projectId="p" addToast={vi.fn()} onClose={vi.fn()} /></ConfirmDialogProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("note indisponible");
    expect(api.fetchNote).toHaveBeenCalledTimes(1);
  });

  it("notifie la liste partagée après sauvegarde et ferme seulement après suppression", async () => {
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialogProvider><PoppedOutNoteWindows entries={[{ projectId: "p", note: summary("n1", "Première"), focusNonce: 1, cascadeSlot: 0 }]} projectId="p" addToast={vi.fn()} onClose={onClose} onChanged={onChanged} /></ConfirmDialogProvider>);
    const editor = await screen.findByLabelText("editor-n1.md");
    fireEvent.change(editor, { target: { value: "sauvé" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});
