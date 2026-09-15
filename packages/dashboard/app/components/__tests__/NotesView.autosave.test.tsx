import { act, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("../FileEditor", () => ({ FileEditor: ({ content, onChange }: any) => <div className="file-editor-container"><textarea aria-label="Markdown editor" value={content} onChange={(event) => onChange(event.target.value)} /></div> }));

const note = { id: "n", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const noteB = { ...note, id: "b", title: "Journal", content: "logs B" };
const AUTOSAVE_DELAY_MS = 800;

/*
FNXC:NotesEditing 2026-09-15-21:23:
FN-435 : ces cas sont la contrepartie du bouton Enregistrer supprimé. Ils utilisent exclusivement des minuteries
factices : une attente réelle de 800 ms par cas transformerait cette couverture en test lent, ce que ce dépôt refuse.
*/
describe("NotesView — enregistrement automatique", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    api.fetchNotes.mockResolvedValue({ notes: [note, noteB] });
    api.fetchNote.mockImplementation((_projectId: string, id: string) => Promise.resolve(id === noteB.id ? noteB : note));
    api.updateNote.mockResolvedValue({ ...note, content: "modifié", revision: 2 });
    api.deleteNote.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async () => { await act(async () => { await Promise.resolve(); }); };
  const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };

  async function openNote(props: Partial<React.ComponentProps<typeof NotesView>> = {}) {
    const view = render(<ConfirmDialogProvider><NotesView projectId="p" {...props} /></ConfirmDialogProvider>);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Commande/ }));
    await settle();
    return view;
  }

  const type = (value: string) => fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value } });

  it("n'émet aucune requête avant l'échéance de l'anti-rebond", async () => {
    await openNote();
    type("modifié");
    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it("émet exactement une écriture après l'échéance", async () => {
    await openNote();
    type("modifié");
    await advance(AUTOSAVE_DELAY_MS);
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(api.updateNote).toHaveBeenCalledWith("p", note.id, { title: note.title, content: "modifié", expectedRevision: 1 });
  });

  it("coalesce deux frappes rapprochées en une seule écriture", async () => {
    await openNote();
    type("m");
    await advance(AUTOSAVE_DELAY_MS / 2);
    type("modifié");
    await advance(AUTOSAVE_DELAY_MS / 2);
    expect(api.updateNote).not.toHaveBeenCalled();
    await advance(AUTOSAVE_DELAY_MS);
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(api.updateNote).toHaveBeenCalledWith("p", note.id, { title: note.title, content: "modifié", expectedRevision: 1 });
  });

  it("vide l'anti-rebond et enregistre avant de charger une autre note", async () => {
    await openNote();
    type("modifié");
    fireEvent.click(screen.getByRole("button", { name: /^Journal/ }));
    await settle();
    await settle();
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(api.updateNote).toHaveBeenCalledWith("p", note.id, { title: note.title, content: "modifié", expectedRevision: 1 });
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(api.updateNote).toHaveBeenCalledTimes(1);
  });

  it("enregistre avant de revenir à la liste", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({ matches: query.includes("max-width") || query.includes("max-height"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })),
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      await openNote();
      type("modifié");
      fireEvent.click(screen.getByTestId("notes-back-btn"));
      await settle();
      await settle();
      expect(api.updateNote).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    }
  });

  it("enregistre quand l'hôte se ferme", async () => {
    const onClose = vi.fn();
    await openNote({ floating: { onClose } });
    type("modifié");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await settle();
    await settle();
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("ne retente rien automatiquement après un 409 tant que l'opérateur n'a pas tranché", async () => {
    api.updateNote.mockRejectedValueOnce(new ApiRequestError("conflict", 409, { code: "NOTE_REVISION_CONFLICT" }));
    await openNote();
    type("modifié");
    await advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("This note changed elsewhere. Your draft is preserved.")).toBeInTheDocument();

    type("modifié encore");
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Markdown editor")).toHaveValue("modifié encore");

    api.fetchNote.mockResolvedValueOnce({ ...note, content: "version serveur", revision: 2 });
    api.updateNote.mockResolvedValueOnce({ ...note, content: "modifié encore", revision: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Overwrite with my draft" }));
    await settle();
    await settle();
    expect(api.updateNote).toHaveBeenLastCalledWith("p", note.id, { title: note.title, content: "modifié encore", expectedRevision: 2 });
  });

  /*
  FNXC:NotesEditing 2026-09-15-21:23:
  FN-435 : la garde publiée à l'hôte (changement de projet, de nœud, fermeture) ne confirme plus un brouillon
  ordinaire — il est enregistré tout seul — mais elle doit TOUJOURS confirmer les deux états qu'aucune automatisation
  ne résout. Sans cette distinction, un conflit de révision non tranché serait perdu silencieusement.
  */
  it("ne confirme un abandon que pour un conflit ou un échec d'enregistrement", async () => {
    const guards: Array<() => boolean | Promise<boolean>> = [];
    api.updateNote.mockRejectedValueOnce(new ApiRequestError("conflict", 409, { code: "NOTE_REVISION_CONFLICT" }));
    await openNote({ registerGuard: (guard) => { guards.push(guard); return () => {}; } });

    type("modifié");
    await act(async () => { await guards.at(-1)!(); });
    expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull();

    await advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(await screen.findByText("This note changed elsewhere. Your draft is preserved.")).toBeInTheDocument();

    let verdict!: Promise<boolean | undefined>;
    await act(async () => { verdict = Promise.resolve(guards.at(-1)!() as boolean | Promise<boolean>); });
    expect(await screen.findByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await verdict).toBe(false);
    expect(screen.getByLabelText("Markdown editor")).toHaveValue("modifié");
  });

  it("vide l'anti-rebond au démontage sans avertissement d'état sur composant démonté", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await openNote();
    type("modifié");
    view.unmount();
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("unmounted component");
    warn.mockRestore();
  });
});
