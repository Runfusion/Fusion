import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { NotesView } from "../NotesView";
import * as viewportModule from "../../hooks/useViewportMode";

/*
FNXC:NotesRowActions 2026-09-17-10:37:
FN-506 : quand une note est ouverte, l'en-tête de Notes doit porter les actions rapides de CETTE note (« … »)
au lieu du seul bouton de création. L'invariant couvert : l'affordance d'en-tête dépend de l'état de l'hôte
(liste vs note confirmée), le menu ouvert est le menu PARTAGÉ existant, la création survit à l'intérieur,
le renommage reste EN PLACE dans la ligne (décision FN-435) — donc un écran étroit revient d'abord à la liste —
et aucune coquille de bouton ne subsiste dans l'en-tête, sur desktop comme sur téléphone.
*/

const api = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock("../../api/notes", () => api);
vi.mock("../FileEditor", () => ({
  FileEditor: ({ content, onChange }: any) => (
    <div className="file-editor-container">
      <textarea aria-label="Markdown editor" value={content} onChange={(event) => onChange(event.target.value)} />
    </div>
  ),
}));

const note = { id: "n", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const noteB = { ...note, id: "b", title: "Journal", content: "logs B" };

const settle = async () => { await act(async () => { await Promise.resolve(); }); };

function renderNotes(props: Partial<React.ComponentProps<typeof NotesView>> = {}) {
  return render(<ConfirmDialogProvider><NotesView projectId="p" {...props} /></ConfirmDialogProvider>);
}

async function openNote(props: Partial<React.ComponentProps<typeof NotesView>> = {}) {
  const view = renderNotes(props);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Commande/ }));
  await settle();
  return view;
}

function header() {
  return screen.getByRole("banner");
}

/** Aucun bouton d'en-tête ne doit rester sans nom accessible après le retrait du bouton de création. */
function expectNoEmptyHeaderButtons() {
  for (const button of within(header()).getAllByRole("button")) {
    const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
    expect(name.length).toBeGreaterThan(0);
  }
}

describe("NotesView — en-tête contextuel de note (FN-506)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchNotes.mockResolvedValue({ notes: [note, noteB] });
    api.fetchNote.mockImplementation((_projectId: string, id: string) => Promise.resolve(id === noteB.id ? noteB : note));
    api.createNote.mockResolvedValue({ ...note, id: "created", title: "Nouvelle note", content: "" });
    api.updateNote.mockResolvedValue({ ...note, title: "Renommée", revision: 2 });
    api.deleteNote.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // Cas (b) : note ouverte sur desktop — « … » présent, bouton de création absent, aucune coquille.
  it("remplace le bouton de création par « … » quand une note est ouverte", async () => {
    await openNote();

    expect(within(header()).queryByRole("button", { name: "New note" })).toBeNull();
    expect(header().querySelector(".view-action-button--create")).toBeNull();
    const trigger = within(header()).getByTestId("notes-header-actions-btn");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.getAttribute("aria-label")).toContain("Commande");
    expectNoEmptyHeaderButtons();
  });

  // État liste : le bouton de création reste strictement inchangé.
  it("garde le bouton de création en état liste", async () => {
    renderNotes();
    await settle();

    expect(within(header()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(header()).queryByTestId("notes-header-actions-btn")).toBeNull();
  });

  // Actions rendues au clic, dans le menu PARTAGÉ (un seul rendu).
  it("ouvre Nouvelle note, Renommer et Supprimer depuis l'en-tête", async () => {
    await openNote();

    fireEvent.click(screen.getByTestId("notes-header-actions-btn"));
    await settle();

    const menu = screen.getByRole("menu");
    expect(menu).toHaveAccessibleName("Note actions for Commande");
    expect(within(menu).getByTestId("notes-menu-new")).toBeInTheDocument();
    expect(within(menu).getByTestId("notes-menu-rename")).toBeInTheDocument();
    expect(within(menu).getByTestId("notes-menu-delete")).toBeInTheDocument();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByTestId("notes-header-actions-btn")).toHaveAttribute("aria-expanded", "true");
  });

  it("crée une note depuis l'entrée Nouvelle note de l'en-tête", async () => {
    await openNote();

    fireEvent.click(screen.getByTestId("notes-header-actions-btn"));
    await settle();
    fireEvent.click(screen.getByTestId("notes-menu-new"));
    await settle();

    expect(api.createNote).toHaveBeenCalledTimes(1);
  });

  // Cas (c) : desktop, rail visible — Renommer active la saisie en place SANS quitter la note.
  it("active le renommage en place sans quitter la note quand le rail est visible", async () => {
    await openNote();

    fireEvent.click(screen.getByTestId("notes-header-actions-btn"));
    await settle();
    fireEvent.click(screen.getByTestId("notes-menu-rename"));
    await settle();

    expect(await screen.findByTestId("notes-list-item-rename-input")).toHaveValue("Commande");
    expect(screen.getByLabelText("Markdown editor")).toBeInTheDocument();
  });

  // Cas (d) : téléphone — Renommer revient d'abord à la liste, puis active la saisie en place.
  it("revient à la liste avant le renommage quand le rail n'est pas visible", async () => {
    vi.spyOn(viewportModule, "useViewportMode").mockReturnValue("mobile");
    await openNote();

    expect(within(header()).getByTestId("notes-header-actions-btn")).toBeInTheDocument();
    expectNoEmptyHeaderButtons();

    fireEvent.click(screen.getByTestId("notes-header-actions-btn"));
    await settle();
    fireEvent.click(screen.getByTestId("notes-menu-rename"));
    await settle();

    await waitFor(() => {
      expect(screen.getByTestId("notes-list-item-rename-input")).toHaveValue("Commande");
    });
    // Retour à la liste effectif : plus d'éditeur, donc plus de note ouverte.
    expect(screen.queryByLabelText("Markdown editor")).toBeNull();
  });

  // Cas (e) : sélection en attente — `confirmedNote` est nul, la création reste en place.
  it("garde le bouton de création tant que la sélection n'est pas confirmée", async () => {
    let resolveNote: ((value: typeof note) => void) | undefined;
    api.fetchNote.mockImplementation(() => new Promise<typeof note>((resolve) => { resolveNote = resolve; }));
    renderNotes();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /^Commande/ }));
    await settle();

    expect(screen.getByTestId("notes-detail-pending")).toBeInTheDocument();
    expect(within(header()).queryByTestId("notes-header-actions-btn")).toBeNull();
    expect(within(header()).getByRole("button", { name: "New note" })).toBeInTheDocument();

    await act(async () => { resolveNote?.(note); await Promise.resolve(); });
    expect(await screen.findByTestId("notes-header-actions-btn")).toBeInTheDocument();
  });

  // Cas (f) : la note disparaît des données courantes — l'effet existant ferme le menu.
  it("ferme le menu d'en-tête quand la note quitte les données courantes", async () => {
    await openNote();

    fireEvent.click(screen.getByTestId("notes-header-actions-btn"));
    await settle();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    api.fetchNotes.mockResolvedValue({ notes: [noteB] });
    fireEvent.change(screen.getByLabelText("Search notes"), { target: { value: "Journal" } });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  // Contrôle négatif : le dock `listOnly` reste propriétaire de liste.
  it("garde toujours le bouton de création dans l'hôte listOnly", async () => {
    renderNotes({ listOnly: true });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Commande/ }));
    await settle();

    expect(within(header()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(header()).queryByTestId("notes-header-actions-btn")).toBeNull();
  });

  // Contrôle négatif : la fenêtre dédiée est l'exemption documentée.
  it("ne rend aucune des deux affordances dans une fenêtre de note dédiée", async () => {
    renderNotes({ dedicatedNoteId: note.id, dedicatedNote: note, floating: { onClose: vi.fn() } });
    await settle();

    expect(screen.queryByTestId("notes-header-actions-btn")).toBeNull();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });
});
