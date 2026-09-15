import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const noteC = { ...note, id: "c", title: "Journal", content: "logs C" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;
const renderNotes = (...args: [projectId?: string]) => {
  const projectId = args.length === 0 ? "p" : args[0];
  return render(<ConfirmDialogProvider><NotesView projectId={projectId} /></ConfirmDialogProvider>);
};

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
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    window.dispatchEvent(new Event("resize"));
  });

  it("garde le dock en liste et délègue l’ouverture sans charger le détail", async () => {
    const onOpenNote = vi.fn();
    render(<ConfirmDialogProvider><NotesView projectId="p" compact listOnly onOpenNote={onOpenNote} /></ConfirmDialogProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Commande/ }));
    expect(onOpenNote).toHaveBeenCalledWith(expect.objectContaining({ id: "n" }));
    expect(api.fetchNote).not.toHaveBeenCalled();
    expect(document.querySelector(".notes-detail")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("fills the host with the shared edge-to-edge rail and detail split", async () => {
    renderNotes();
    await screen.findByRole("button", { name: /Commande/ });
    const view = screen.getByRole("region", { name: "Notes" });
    const layout = view.querySelector<HTMLElement>(".view-layout");
    const rail = view.querySelector<HTMLElement>(".view-sidebar__panel");
    const detail = view.querySelector<HTMLElement>(".notes-detail");
    expect(getComputedStyle(view).display).toBe("flex");
    expect(layout).not.toBeNull();
    expect(rail!.querySelector(".notes-list")).not.toBeNull();
    expect(detail).not.toBeNull();
    expect(view.querySelector(".view-layout__content")!.contains(detail!)).toBe(true);
    expect(view.querySelectorAll(".notes-list, .notes-detail")).toHaveLength(2);
  });

  it("keeps hover and keyboard focus separate from semantic selection", async () => {
    const selection = deferred<typeof noteB>();
    api.fetchNotes.mockResolvedValue({ notes: [note, noteB] });
    api.fetchNote.mockReturnValue(selection.promise);
    renderNotes();
    const items = await screen.findAllByRole("button", { name: /Commande|Journal/ });
    fireEvent.mouseEnter(items[0]);
    items[0].focus();
    expect(items[0]).toHaveFocus();
    expect(items[0]).not.toHaveAttribute("aria-current");
    fireEvent.click(items[1]);
    await waitFor(() => expect(items[1]).toHaveAttribute("aria-current", "page"));
    expect(items[0]).not.toHaveAttribute("aria-current");
  });

  it("does not request data without a project or leave decorative card shells", () => {
    renderNotes(undefined);
    expect(api.fetchNotes).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
    const view = screen.getByRole("region", { name: "Notes" });
    expect(view.querySelectorAll(".notes-list, .notes-detail")).toHaveLength(2);
    expect(view.querySelectorAll(".card")).toHaveLength(0);
  });

  it("renders loading and list failure states inside the same split", async () => {
    const loading = deferred<{ notes: typeof note[] }>();
    api.fetchNotes.mockReturnValueOnce(loading.promise);
    const view = renderNotes();
    expect((await screen.findAllByText("Loading…")).length).toBeGreaterThan(0);
    loading.resolve({ notes: [note] });
    await screen.findByRole("button", { name: /Commande/ });
    view.unmount();

    api.fetchNotes.mockRejectedValueOnce(new Error("liste indisponible"));
    renderNotes();
    expect(await screen.findByRole("alert")).toHaveTextContent("liste indisponible");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders an accessible empty state and creates the first note through the production hook", async () => {
    api.fetchNotes.mockResolvedValue({ notes: [] });
    renderNotes();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create your first note" })).toBeNull();
    const create = await screen.findByRole("button", { name: "New note" });
    fireEvent.click(create);
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith("p", { title: "Nouvelle note", content: "" }));
    expect(await screen.findByLabelText("Note title")).toHaveValue(note.title);
  });

  it("marks the clicked note immediately and keeps it selected after detail loading", async () => {
    const selection = deferred<typeof noteB>();
    api.fetchNotes.mockResolvedValue({ notes: [note, noteB] });
    api.fetchNote.mockReturnValue(selection.promise);
    renderNotes();
    const selected = await screen.findByRole("button", { name: /Journal/ });
    fireEvent.click(selected);
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "page")).toEqual([selected]);
    await waitFor(() => expect(api.fetchNote).toHaveBeenCalledWith("p", noteB.id));
    await act(async () => { selection.resolve(noteB); await selection.promise; });
    expect(await screen.findByLabelText("Note title")).toHaveValue(noteB.title);
    expect(selected).toHaveAttribute("aria-current", "page");
  });

  it("keeps the latest rapid click as the sole semantic selection", async () => {
    const selectionB = deferred<typeof noteB>();
    const selectionC = deferred<typeof noteC>();
    api.fetchNotes.mockResolvedValue({ notes: [noteB, noteC] });
    api.fetchNote.mockImplementation((_projectId: string, id: string) => id === noteB.id ? selectionB.promise : selectionC.promise);
    renderNotes();
    const duplicateTitles = await screen.findAllByRole("button", { name: /Journal/ });
    fireEvent.click(duplicateTitles[0]);
    fireEvent.click(duplicateTitles[1]);
    expect(duplicateTitles[0]).not.toHaveAttribute("aria-current");
    expect(duplicateTitles[1]).toHaveAttribute("aria-current", "page");
    await act(async () => { selectionC.resolve(noteC); await selectionC.promise; });
    expect(await screen.findByLabelText("Note title")).toHaveValue(noteC.title);
    await act(async () => { selectionB.resolve(noteB); await selectionB.promise; });
    await waitFor(() => expect(api.fetchNote).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Markdown editor")).toHaveValue(noteC.content);
    expect(duplicateTitles[0]).not.toHaveAttribute("aria-current");
    expect(duplicateTitles[1]).toHaveAttribute("aria-current", "page");
  });

  it("keeps C pending when the earlier rapid click rejects", async () => {
    const selectionB = deferred<typeof noteB>();
    const selectionC = deferred<typeof noteC>();
    api.fetchNotes.mockResolvedValue({ notes: [noteB, noteC] });
    api.fetchNote.mockImplementation((_projectId: string, id: string) => id === noteB.id ? selectionB.promise : selectionC.promise);
    renderNotes();
    const duplicateTitles = await screen.findAllByRole("button", { name: /Journal/ });
    fireEvent.click(duplicateTitles[0]);
    fireEvent.click(duplicateTitles[1]);

    await act(async () => {
      selectionB.reject(new Error("échec B"));
      await selectionB.promise.catch(() => undefined);
    });
    expect(duplicateTitles[0]).not.toHaveAttribute("aria-current");
    expect(duplicateTitles[1]).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument();

    await act(async () => { selectionC.resolve(noteC); await selectionC.promise; });
    expect(await screen.findByLabelText("Markdown editor")).toHaveValue(noteC.content);
    expect(duplicateTitles[0]).not.toHaveAttribute("aria-current");
    expect(duplicateTitles[1]).toHaveAttribute("aria-current", "page");
  });

  it("retries the failed note selection without saving the previously loaded note", async () => {
    api.fetchNotes.mockResolvedValue({ notes: [note, noteB] });
    api.fetchNote
      .mockResolvedValueOnce(note)
      .mockRejectedValueOnce(new Error("lecture impossible"))
      .mockResolvedValueOnce(noteB);
    renderNotes();
    fireEvent.click(await screen.findByRole("button", { name: /Commande/ }));
    await screen.findByLabelText("Note title");
    fireEvent.click(screen.getByRole("button", { name: /Journal/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("lecture impossible");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.fetchNote).toHaveBeenCalledTimes(3));
    expect(api.fetchNote).toHaveBeenLastCalledWith("p", noteB.id);
    expect(api.updateNote).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Markdown editor")).toHaveValue(noteB.content);
  });

  it("protects edits made after a failed selection before retrying it", async () => {
    api.fetchNotes.mockResolvedValue({ notes: [note, noteB] });
    api.fetchNote
      .mockResolvedValueOnce(note)
      .mockRejectedValueOnce(new Error("lecture impossible"))
      .mockResolvedValueOnce(noteB);
    renderNotes();
    fireEvent.click(await screen.findByRole("button", { name: /Commande/ }));
    await screen.findByLabelText("Note title");
    fireEvent.click(screen.getByRole("button", { name: /Journal/ }));
    const alert = await screen.findByRole("alert");

    fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value: "brouillon A après échec" } });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    let dialog = await screen.findByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.fetchNote).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Markdown editor")).toHaveValue("brouillon A après échec");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    dialog = await screen.findByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(api.fetchNote).toHaveBeenCalledTimes(3));
    expect(api.fetchNote).toHaveBeenLastCalledWith("p", noteB.id);
    expect(api.updateNote).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Markdown editor")).toHaveValue(noteB.content);
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

  /*
  FNXC:ProjectNotes 2026-09-15-03:29:
  FN-404 : l’adoption d’une révision externe appartient exclusivement à la fenêtre dédiée. La page Notes standard et la
  liste `listOnly` du dock ne reçoivent jamais `dedicatedNote` et ne doivent déclencher aucune sélection supplémentaire,
  même quand la liste partagée republie une note renommée.
  */
  it("ne déclenche aucune sélection supplémentaire sur la page standard ni dans le dock listOnly", async () => {
    const renamed = { ...note, title: "Renommée", revision: 2, updatedAt: "2026-01-02" };
    const standard = render(<ConfirmDialogProvider><NotesView projectId="p" /></ConfirmDialogProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Commande/ }));
    await screen.findByLabelText("Note title");
    expect(api.fetchNote).toHaveBeenCalledTimes(1);

    api.fetchNotes.mockResolvedValue({ notes: [renamed] });
    standard.rerender(<ConfirmDialogProvider><NotesView projectId="p" /></ConfirmDialogProvider>);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Commande"));
    expect(api.fetchNote).toHaveBeenCalledTimes(1);
    standard.unmount();

    const onOpenNote = vi.fn();
    const dock = render(<ConfirmDialogProvider><NotesView projectId="p" compact listOnly onOpenNote={onOpenNote} /></ConfirmDialogProvider>);
    await screen.findByRole("button", { name: /Renommée/ });
    dock.rerender(<ConfirmDialogProvider><NotesView projectId="p" compact listOnly onOpenNote={onOpenNote} /></ConfirmDialogProvider>);
    expect(api.fetchNote).toHaveBeenCalledTimes(1);
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it("defines the canonical narrow and short-screen single-panel contract", () => {
    renderNotes();
    const mediaRules = Array.from(document.styleSheets).flatMap((sheet) => {
      try { return Array.from(sheet.cssRules).filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule); }
      catch { return []; }
    });
    /*
    FNXC:NotesCollectionLayout 2026-09-15-03:29:
    Plusieurs feuilles partagent désormais la même condition de media query étroite/peu haute, donc sélectionner la
    première règle trouvée pouvait inspecter celle d’un autre composant. Le contrat mobile de Notes est asserté sur
    l’ensemble des règles portant cette condition, restreint aux sélecteurs de Notes.
    */
    const notesResponsiveRules = mediaRules
      .filter((rule) => rule.conditionText.includes("max-width: 768px") && rule.conditionText.includes("max-height: 480px"))
      .flatMap((rule) => Array.from(rule.cssRules).map((inner) => inner.cssText))
      .filter((cssText) => cssText.includes(".notes-"));
    expect(notesResponsiveRules.length).toBeGreaterThan(0);
    const responsiveCss = notesResponsiveRules.join(" ");
    expect(responsiveCss).toContain(".notes-view--detail .notes-list");
    expect(responsiveCss).toContain(".notes-view:not(.notes-view--detail) .notes-detail");
    expect(responsiveCss.match(/display: none/g)).toHaveLength(2);
  });

  it.each([
    { width: 390, height: 844, label: "portrait phone" },
    { width: 844, height: 480, label: "short landscape phone" },
  ])("offers an accessible full-panel back target on $label", async ({ width, height }) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    await openNote();
    fireEvent.change(screen.getByLabelText("Markdown editor"), { target: { value: "brouillon mobile" } });
    fireEvent.click(screen.getByLabelText("Back"));
    const dialog = await screen.findByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Commande/ })).toBeInTheDocument();
    const view = screen.getByRole("region", { name: "Notes" });
    expect(view.querySelectorAll(".notes-list, .notes-detail")).toHaveLength(2);
  });
});
