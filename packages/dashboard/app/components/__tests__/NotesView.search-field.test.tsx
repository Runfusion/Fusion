import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  FileEditor: ({ content, onChange }: any) => (
    <textarea aria-label="Markdown editor" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

/*
FNXC:DashboardSearchField 2026-09-17-02:59:
FN-485 : l'invariant n'est pas « la page Notes ne fuit plus son libellé », c'est « aucun hôte porteur de la
liste ne rend d'icône ou de texte d'invite HORS du champ, et aucun n'emploie la classe fantôme `sr-only` ».
Les quatre hôtes porteurs de la liste et la fenêtre de note dédiée (qui ne doit PAS rendre de champ) sont
énumérés ici, ainsi que les six états de données, parce qu'une affordance supprimée survit exactement dans
l'hôte ou l'état qu'on a oublié d'énumérer.
*/
const note = { id: "n", title: "Commande", content: "pnpm test", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };

const listHosts: Array<{ name: string; props: Partial<NotesViewProps> }> = [
  { name: "page standard", props: {} },
  { name: "popover d'en-tête", props: { compact: true } },
  { name: "tiroir téléphone", props: {} },
  { name: "liste compacte du dock", props: { compact: true, listOnly: true, onOpenNote: vi.fn() } },
];

const PLACEHOLDER = "Search notes";

const mount = (props: Partial<NotesViewProps>) =>
  render(<ConfirmDialogProvider><NotesView projectId="p" {...props} /></ConfirmDialogProvider>);

function expectComposedSearchField(): HTMLInputElement {
  const input = screen.getByRole("searchbox", { name: PLACEHOLDER }) as HTMLInputElement;
  expect(input).toHaveAttribute("placeholder", PLACEHOLDER);
  expect(input).toHaveAttribute("type", "search");

  // L'icône ET le champ sont enfants du MÊME conteneur de champ.
  const field = input.closest(".search-field");
  expect(field).not.toBeNull();
  const icon = field!.querySelector("svg");
  expect(icon).not.toBeNull();
  expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(icon!.parentElement).toBe(field);

  // Aucune classe fantôme, et aucun texte d'invite rendu hors du champ.
  expect(document.querySelectorAll(".sr-only")).toHaveLength(0);
  const leaked = Array.from(document.querySelectorAll("*")).filter(
    (el) => el.children.length === 0 && el.textContent?.trim() === PLACEHOLDER,
  );
  expect(leaked).toEqual([]);
  return input;
}

describe("NotesView — champ de recherche unique", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchNotes.mockResolvedValue({ notes: [note] });
    api.fetchNote.mockResolvedValue(note);
  });
  afterEach(() => vi.clearAllMocks());

  it.each(listHosts)("compose l'icône et l'invite dans le champ pour $name", async ({ props }) => {
    mount(props);
    await screen.findByRole("button", { name: /^Commande/ });
    expectComposedSearchField();
  });

  it("ne rend aucun champ de recherche dans la fenêtre de note dédiée", async () => {
    mount({ dedicatedNoteId: note.id });
    await screen.findByLabelText("Markdown editor");
    expect(screen.queryByRole("searchbox", { name: PLACEHOLDER })).toBeNull();
    expect(document.querySelector(".search-field")).toBeNull();
  });

  it("transmet toujours la saisie au contrôleur de recherche", async () => {
    mount({});
    await screen.findByRole("button", { name: /^Commande/ });
    const input = expectComposedSearchField();
    fireEvent.change(input, { target: { value: "commande" } });
    expect((screen.getByRole("searchbox", { name: PLACEHOLDER }) as HTMLInputElement).value).toBe("commande");
    await waitFor(() => expect(api.fetchNotes).toHaveBeenCalledWith("p", "commande"));
  });

  const states: Array<{ name: string; arrange: () => void; settle: () => Promise<unknown> }> = [
    {
      name: "requête vide avec résultats",
      arrange: () => api.fetchNotes.mockResolvedValue({ notes: [note] }),
      settle: () => screen.findByRole("button", { name: /^Commande/ }),
    },
    {
      name: "liste vide",
      arrange: () => api.fetchNotes.mockResolvedValue({ notes: [] }),
      settle: () => screen.findByText("No notes yet"),
    },
    {
      name: "chargement",
      arrange: () => api.fetchNotes.mockReturnValue(new Promise(() => {})),
      settle: () => waitFor(() => expect(document.querySelector(".notes-state")).not.toBeNull()),
    },
    {
      name: "erreur de liste",
      arrange: () => api.fetchNotes.mockRejectedValue(new Error("boom")),
      settle: () => screen.findByRole("button", { name: "Retry" }),
    },
  ];

  it.each(states)("conserve la composition du champ dans l'état $name", async ({ arrange, settle }) => {
    arrange();
    mount({});
    await settle();
    expectComposedSearchField();
  });

  it("conserve la composition du champ quand une requête ne donne aucun résultat", async () => {
    mount({});
    await screen.findByRole("button", { name: /^Commande/ });
    api.fetchNotes.mockResolvedValue({ notes: [] });
    fireEvent.change(screen.getByRole("searchbox", { name: PLACEHOLDER }), { target: { value: "zzz" } });
    await screen.findByText("No notes found");
    expectComposedSearchField();
  });
});
