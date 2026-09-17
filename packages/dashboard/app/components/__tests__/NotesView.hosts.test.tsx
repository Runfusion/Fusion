import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { NotesView, type NotesViewProps } from "../NotesView";

const api = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock("../../api/notes", () => api);
vi.mock("../FileEditor", () => ({
  FileEditor: ({ content, onChange, hideToolbar }: any) => (
    <div className="file-editor-container" data-hide-toolbar={String(Boolean(hideToolbar))}>
      <textarea aria-label="Markdown editor" value={content} onChange={(event) => onChange(event.target.value)} />
    </div>
  ),
}));

const note = { id: "n", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const emptyNote = { ...note, id: "e", title: "Vide", content: "" };

/*
FNXC:NotesEditing 2026-09-15-21:23:
FN-435 : NotesView possède cinq hôtes de production — page standard, popover d'en-tête (écran large), tiroir téléphone,
liste `compact listOnly` du dock optionnel, et fenêtre de note dédiée. L'invariant est UNIQUE et doit tenir dans les
cinq : aucun contrôle d'édition dans la zone d'édition, enregistrement automatique là où un éditeur est monté, menu
d'actions là où une liste est montée. Un hôte qui échapperait à cette énumération est exactement la façon dont une
affordance supprimée survit quelque part.
*/
const hosts: Array<{ name: string; props: Partial<NotesViewProps>; hasList: boolean; hasEditor: boolean }> = [
  { name: "page standard", props: {}, hasList: true, hasEditor: true },
  { name: "popover d'en-tête", props: { compact: true }, hasList: true, hasEditor: true },
  { name: "tiroir téléphone", props: {}, hasList: true, hasEditor: true },
  { name: "liste compacte du dock", props: { compact: true, listOnly: true, onOpenNote: vi.fn() }, hasList: true, hasEditor: false },
  { name: "fenêtre de note dédiée", props: { dedicatedNoteId: note.id }, hasList: false, hasEditor: true },
];

describe("NotesView — invariant partagé par les cinq hôtes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchNotes.mockResolvedValue({ notes: [note] });
    api.fetchNote.mockResolvedValue(note);
    api.updateNote.mockResolvedValue({ ...note, content: "modifié", revision: 2 });
    api.deleteNote.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  const mount = (props: Partial<NotesViewProps>) =>
    render(<ConfirmDialogProvider><NotesView projectId="p" {...props} /></ConfirmDialogProvider>);

  it.each(hosts)("ne rend aucun contrôle d'édition dans $name", async ({ props, hasList, hasEditor }) => {
    mount(props);
    if (hasList) await screen.findAllByTestId("notes-list-item-context-row");
    if (hasEditor && !props.dedicatedNoteId) {
      fireEvent.click(await screen.findByRole("button", { name: /^Commande/ }));
    }
    if (hasEditor) await screen.findByLabelText("Markdown editor");

    expect(screen.queryByLabelText("Note title")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Preview$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
    expect(document.querySelector(".notes-detail-toolbar")).toBeNull();
  });

  it.each(hosts.filter((host) => host.hasEditor))("monte l'éditeur sans barre d'outils et l'enregistre automatiquement dans $name", async ({ props }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount(props);
      if (!props.dedicatedNoteId) {
        await vi.waitFor(() => expect(screen.getByRole("button", { name: /^Commande/ })).toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: /^Commande/ }));
      }
      await vi.waitFor(() => expect(screen.getByLabelText("Markdown editor")).toBeInTheDocument());
      expect(document.querySelector(".file-editor-container")).toHaveAttribute("data-hide-toolbar", "true");

      fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value: "modifié" } });
      await vi.advanceTimersByTimeAsync(900);
      expect(api.updateNote).toHaveBeenCalledWith("p", note.id, { title: note.title, content: "modifié", expectedRevision: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  /*
  FNXC:NotesRowActions 2026-09-17-03:18:
  FN-486 : chaque hôte à liste sert les mêmes actions par clic droit ou appui long sur la ligne. Aucun bouton
  « … » ne subsiste dans aucun hôte, et la fenêtre dédiée (détail seul) ne gagne aucune affordance.
  */
  it.each(hosts.filter((host) => host.hasList))("expose le menu d'actions par ligne dans $name", async ({ props }) => {
    mount(props);
    const triggers = await screen.findAllByTestId("notes-list-item-context-row");
    expect(triggers).toHaveLength(1);
    expect(screen.queryByTestId("notes-list-item-menu-btn")).toBeNull();
    fireEvent.contextMenu(triggers[0], { clientX: 12, clientY: 12 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  /*
  FNXC:ProjectNotes 2026-09-16-05:02:
  FN-454 : l'identité de la note confirmée doit être lisible dans CHAQUE hôte qui monte un éditeur, et une note vide doit
  s'ouvrir vide. Le dock `listOnly` reste une simple délégation d'ouverture et ne monte toujours aucun éditeur.
  */
  it.each(hosts.filter((host) => host.hasEditor))("révèle la note confirmée et ouvre une note vide vide dans $name", async ({ props }) => {
    api.fetchNotes.mockResolvedValue({ notes: [note, emptyNote] });
    api.fetchNote.mockImplementation((_projectId: string, id: string) => Promise.resolve(id === emptyNote.id ? emptyNote : note));
    const dedicatedProps = props.dedicatedNoteId ? { ...props, dedicatedNoteId: emptyNote.id } : props;
    mount(dedicatedProps);
    if (!props.dedicatedNoteId) {
      fireEvent.click(await screen.findByRole("button", { name: /^Commande/ }));
      expect(await screen.findByRole("heading", { name: "Commande" })).toBeInTheDocument();
      expect(screen.getByLabelText("Markdown editor")).toHaveValue(note.content);
      fireEvent.click(screen.getByRole("button", { name: /^Vide/ }));
    }
    expect(await screen.findByRole("heading", { name: "Vide" })).toBeInTheDocument();
    expect(screen.getByLabelText("Markdown editor")).toHaveValue("");
  });

  it("la liste compacte du dock délègue toujours l'ouverture plutôt que de charger un détail", async () => {
    const onOpenNote = vi.fn();
    mount({ compact: true, listOnly: true, onOpenNote });
    fireEvent.click(await screen.findByRole("button", { name: /^Commande/ }));
    await waitFor(() => expect(onOpenNote).toHaveBeenCalledWith(expect.objectContaining({ id: note.id })));
    expect(api.fetchNote).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Markdown editor")).toBeNull();
    expect(screen.queryByTestId("notes-detail-pending")).toBeNull();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
  });
});
