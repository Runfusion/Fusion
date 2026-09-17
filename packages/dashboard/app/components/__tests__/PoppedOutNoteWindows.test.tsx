import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { PoppedOutNoteWindows } from "../PoppedOutNoteWindows";

const api = vi.hoisted(() => ({ fetchNotes: vi.fn(), fetchNote: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn() }));
vi.mock("../../api/notes", () => api);
vi.mock("../FileEditor", () => ({ FileEditor: ({ content, onChange, filePath }: { content: string; onChange: (value: string) => void; filePath: string }) => <textarea aria-label={`editor-${filePath}`} value={content} onChange={(event) => onChange(event.target.value)} /> }));

const summary = (id: string, title: string) => ({ id, title, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const full = (id: string, title: string, content: string) => ({ ...summary(id, title), content, revision: 1 });
/*
FNXC:ProjectNotes 2026-09-15-03:29:
FN-404 : toute fixture nouvelle est un `ProjectNoteSummary` complet, `revision` incluse, parce que l'adoption d'un
renommage externe est décidée par comparaison de révisions. Les fixtures historiques ci-dessus restent inchangées.
*/
const liveSummary = (id: string, title: string, revision: number, updatedAt: string) => ({ id, title, revision, createdAt: "2026-01-01T00:00:00.000Z", updatedAt });
const noteWindows = (entries: Array<{ projectId: string; note: ReturnType<typeof liveSummary>; focusNonce: number }>, props: Partial<{ onClose: () => void; onChanged: () => void }> = {}) => (
  <ConfirmDialogProvider><PoppedOutNoteWindows entries={entries} projectId="p" addToast={vi.fn()} onClose={props.onClose ?? vi.fn()} onChanged={props.onChanged} /></ConfirmDialogProvider>
);

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

  /*
  FNXC:ProjectNotes 2026-09-15-03:29:
  FN-404 : reproduction du symptôme. L'instantané capturé à l'ouverture n'est pas l'identité durable de la note ; un
  renommage effectué depuis la page Notes doit atteindre la fenêtre déjà montée, sans fermeture/réouverture.
  */
  it("adopte un renommage externe dans le titre de la fenêtre détachée déjà ouverte", async () => {
    const server: Record<string, ReturnType<typeof full>> = { n1: full("n1", "Première", "brouillon un") };
    api.fetchNote.mockImplementation(async (_projectId: string, id: string) => server[id]);
    const entry = { projectId: "p", note: liveSummary("n1", "Première", 1, "2026-01-01T00:00:00.000Z"), focusNonce: 1 };
    const view = render(noteWindows([entry]));

    await screen.findByLabelText("editor-n1.md");
    const overlay = screen.getByTestId("floating-window-overlay-note-p-n1");
    expect(overlay).toHaveAttribute("aria-label", "Première");
    expect(api.fetchNote).toHaveBeenCalledTimes(1);

    server.n1 = { ...server.n1, title: "Renommée", revision: 2, updatedAt: "2026-01-02T00:00:00.000Z" };
    view.rerender(noteWindows([{ ...entry, note: liveSummary("n1", "Renommée", 2, "2026-01-02T00:00:00.000Z") }]));

    await waitFor(() => expect(screen.getByTestId("floating-window-overlay-note-p-n1")).toHaveAttribute("aria-label", "Renommée"));
    expect(screen.getByRole("heading", { name: "Renommée" })).toBeInTheDocument();
    expect(api.fetchNote).toHaveBeenCalledTimes(2);
  });

  /*
  FNXC:ProjectNotes 2026-09-15-03:29:
  FN-404 : cas négatif obligatoire. Un brouillon sale appartient à l’opérateur : une révision externe plus récente ne
  l’écrase jamais et ne déclenche aucune re-sélection.
  */
  it("n’écrase pas un brouillon sale avec une révision externe plus récente", async () => {
    const server: Record<string, ReturnType<typeof full>> = { n1: full("n1", "Première", "brouillon un") };
    api.fetchNote.mockImplementation(async (_projectId: string, id: string) => server[id]);
    const entry = { projectId: "p", note: liveSummary("n1", "Première", 1, "2026-01-01T00:00:00.000Z"), focusNonce: 1 };
    const view = render(noteWindows([entry]));

    const title = await screen.findByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Titre de l’opérateur" } });
    fireEvent.change(await screen.findByLabelText("editor-n1.md"), { target: { value: "texte local" } });

    server.n1 = { ...server.n1, title: "Renommée ailleurs", content: "texte serveur", revision: 2, updatedAt: "2026-01-02T00:00:00.000Z" };
    view.rerender(noteWindows([{ ...entry, note: liveSummary("n1", "Renommée ailleurs", 2, "2026-01-02T00:00:00.000Z") }]));

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Titre de l’opérateur"));
    expect(screen.getByLabelText("editor-n1.md")).toHaveValue("texte local");
    expect(screen.getByTestId("floating-window-overlay-note-p-n1")).toHaveAttribute("aria-label", "Titre de l’opérateur");
    expect(api.fetchNote).toHaveBeenCalledTimes(1);
  });

  it("ne boucle pas en re-sélection quand la note a disparu ailleurs", async () => {
    api.fetchNote.mockImplementation(async () => { throw new Error("note indisponible"); });
    const entry = { projectId: "p", note: liveSummary("n1", "Première", 1, "2026-01-01T00:00:00.000Z"), focusNonce: 1 };
    const view = render(noteWindows([entry]));
    expect(await screen.findByRole("alert")).toHaveTextContent("note indisponible");

    view.rerender(noteWindows([{ ...entry, note: liveSummary("n1", "Renommée", 2, "2026-01-02T00:00:00.000Z") }]));
    view.rerender(noteWindows([{ ...entry, note: liveSummary("n1", "Renommée", 3, "2026-01-03T00:00:00.000Z") }]));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("note indisponible"));
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
