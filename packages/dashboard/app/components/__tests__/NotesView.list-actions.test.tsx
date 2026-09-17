import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { readAppFile } from "../../test/cssFixture";
import { NotesView } from "../NotesView";

const api = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock("../../api/notes", () => api);
vi.mock("../FileEditor", () => ({ FileEditor: ({ content, onChange }: any) => <div className="file-editor-container"><textarea aria-label="Markdown editor" value={content} onChange={(event) => onChange(event.target.value)} /></div> }));

const note = { id: "n", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const noteB = { ...note, id: "b", title: "Journal", content: "logs B" };

const renderNotes = () => render(<ConfirmDialogProvider><NotesView projectId="p" /></ConfirmDialogProvider>);

/*
FNXC:NotesEditing 2026-09-15-21:23:
FN-435 : le renommage et la suppression d'une note se font depuis la LISTE, comme pour une conversation, et la surface
d'édition ne contient plus aucun bouton. Ces cas pinent les deux moitiés de cet invariant ensemble : ce que la liste
gagne et ce que l'éditeur perd.
*/
describe("NotesView — actions par ligne de liste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchNotes.mockResolvedValue({ notes: [note, noteB] });
    api.fetchNote.mockImplementation((_projectId: string, id: string) => Promise.resolve(id === noteB.id ? noteB : note));
    api.updateNote.mockResolvedValue({ ...noteB, title: "Renommée", revision: 2 });
    api.deleteNote.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  const openRowMenu = async (index: number) => {
    const triggers = await screen.findAllByTestId("notes-list-item-menu-btn");
    fireEvent.click(triggers[index]);
    return triggers[index];
  };

  it("expose Renommer et Supprimer derrière le déclencheur à trois points", async () => {
    renderNotes();
    const trigger = await openRowMenu(1);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAccessibleName("Note actions for Journal");
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("ouvrir le menu ne sélectionne pas la note", async () => {
    renderNotes();
    await openRowMenu(1);
    expect(api.fetchNote).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Markdown editor")).toBeNull();
  });

  it("renomme en place sans changer la sélection courante", async () => {
    renderNotes();
    fireEvent.click(await screen.findByRole("button", { name: /^Commande/ }));
    await screen.findByLabelText("Markdown editor");

    const triggers = screen.getAllByTestId("notes-list-item-menu-btn");
    fireEvent.click(triggers[1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("notes-list-item-rename-input");
    fireEvent.change(input, { target: { value: "Renommée" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(api.updateNote).toHaveBeenCalledWith("p", noteB.id, { title: "Renommée", expectedRevision: 1 }));
    expect(api.fetchNote).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /^Commande/ })).toHaveAttribute("aria-current", "page");
  });

  it("annule le renommage sur Échap sans aucune requête", async () => {
    renderNotes();
    await openRowMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("notes-list-item-rename-input");
    fireEvent.change(input, { target: { value: "Peu importe" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("notes-list-item-rename-input")).toBeNull();
    expect(api.updateNote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Journal/ })).toBeInTheDocument();
  });

  it("supprime depuis la liste après confirmation", async () => {
    renderNotes();
    await openRowMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    let dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteNote).not.toHaveBeenCalled();

    await openRowMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(api.deleteNote).toHaveBeenCalledWith("p", noteB.id, noteB.revision));
  });

  it("ne rend plus aucun bouton Enregistrer, Supprimer, Modifier ou Aperçu dans la zone d'édition", async () => {
    renderNotes();
    fireEvent.click(await screen.findByRole("button", { name: /^Commande/ }));
    const editor = await screen.findByLabelText("Markdown editor");
    const detail = editor.closest(".notes-detail")!;
    expect(within(detail as HTMLElement).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByLabelText("Note title")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Preview$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
  });

  it("ne laisse aucune coquille de barre d'édition dans le DOM ni dans la feuille de style", async () => {
    renderNotes();
    fireEvent.click(await screen.findByRole("button", { name: /^Commande/ }));
    await screen.findByLabelText("Markdown editor");
    expect(document.querySelector(".notes-detail-toolbar")).toBeNull();
    expect(document.querySelector(".notes-title")).toBeNull();
    const css = readAppFile("components/NotesView.css");
    expect(css).not.toContain(".notes-detail-toolbar");
    expect(css).not.toContain(".notes-title");
  });
});
