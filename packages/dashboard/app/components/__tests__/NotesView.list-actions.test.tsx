import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { readAppFile } from "../../test/cssFixture";
import { LIST_ITEM_LONG_PRESS_DELAY_MS } from "../../utils/listItemGesture";
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

  /*
  FNXC:NotesRowActions 2026-09-17-03:18:
  FN-486 : l'entrée n'est plus un bouton « … » mais la LIGNE elle-même, au clic droit (souris) ou par appui
  long (tactile). Les assertions de mutation, de confirmation et de garde de brouillon sont conservées.
  */
  const rowTriggers = async () => screen.findAllByTestId("notes-list-item-context-row");
  const openRowMenu = async (index: number) => {
    const triggers = await rowTriggers();
    fireEvent.contextMenu(triggers[index], { clientX: 24, clientY: 24 });
    return triggers[index];
  };

  it("expose Renommer et Supprimer au clic droit sur la ligne, sans bouton permanent", async () => {
    renderNotes();
    const trigger = await openRowMenu(1);
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByTestId("notes-list-item-menu-btn")).toBeNull();
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAccessibleName("Note actions for Journal");
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

    await openRowMenu(1);
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

  /*
  FNXC:NotesRowActions 2026-09-18-01:13:
  FN-521 : l'opérateur atteint le renommage et la suppression d'une note AU DOIGT, exactement comme sur une
  conversation de planification. Le chemin tactile réel — `pointerdown` de type `touch`, expiration du délai
  d'appui long, puis sélection dans le menu — n'était couvert par aucun cas : seuls le clic droit et
  l'en-tête l'étaient. Le clic de compatibilité qui suit l'appui long ne doit pas ouvrir la note.
  */
  const longPressRow = async (index: number) => {
    const triggers = await rowTriggers();
    const row = triggers[index];
    fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 24, clientY: 24 });
    act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS); });
    fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });
    /* Le navigateur synthétise un clic après l'appui long ; il doit être avalé, pas ouvrir la note. */
    fireEvent.click(row);
    return row;
  };

  it("renomme une note par appui long tactile sans l'ouvrir", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderNotes();
      await longPressRow(1);

      const menu = await screen.findByTestId("notes-list-item-context-menu");
      fireEvent.click(within(menu).getByTestId("notes-menu-rename"));
      const input = screen.getByTestId("notes-list-item-rename-input");
      fireEvent.change(input, { target: { value: "Renommée" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(api.updateNote).toHaveBeenCalledWith("p", noteB.id, { title: "Renommée", expectedRevision: 1 }));
      // Le clic de compatibilité n'a pas sélectionné la note.
      expect(api.fetchNote).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Markdown editor")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supprime une note par appui long tactile après confirmation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderNotes();
      await longPressRow(1);

      const menu = await screen.findByTestId("notes-list-item-context-menu");
      fireEvent.click(within(menu).getByTestId("notes-menu-delete"));
      const dialog = await screen.findByRole("dialog", { name: "Delete note?" });
      fireEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));

      await waitFor(() => expect(api.deleteNote).toHaveBeenCalledWith("p", noteB.id, noteB.revision));
      expect(api.fetchNote).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
