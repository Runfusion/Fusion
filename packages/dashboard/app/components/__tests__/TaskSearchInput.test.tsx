/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 replaced this field's contract, so the assertions that encoded the OLD one are gone rather
 * than adjusted:
 *  - eight-suggestion ceiling and client-side ranking: the corpus is now server-paginated;
 *  - `listbox`/`option` roles: results are focusable cards in a dialog panel, not options;
 *  - Enter-selects-the-highlighted-row: Enter now runs the AI lane and never selects.
 *
 * Restoring any of them would mean restoring the behaviour this task exists to remove.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskSearchInput } from "../TaskSearchInput";

const fetchTaskPage = vi.hoisted(() => vi.fn());
const aiSearchTasks = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({
  fetchTaskPage,
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(async () => []),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  refineTask: vi.fn(),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "wf-a", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));
vi.mock("../../api/tasks/tasks-search", () => ({ aiSearchTasks }));
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }),
}));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Titre ${id}`,
    column: "todo",
    steps: [],
    dependencies: [],
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function page(tasks: Task[], nextCursor: string | null = null) {
  return { tasks, total: tasks.length, hasMore: Boolean(nextCursor), nextCursor };
}

function renderField(props: Partial<Parameters<typeof TaskSearchInput>[0]> = {}) {
  return render(
    <TaskSearchInput
      query="collapse"
      projectId="project-a"
      onSearchChange={props.onSearchChange ?? (() => undefined)}
      {...props}
    />,
  );
}

async function settleDebounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchTaskPage.mockReset();
  aiSearchTasks.mockReset();
  fetchTaskPage.mockResolvedValue(page([]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskSearchInput — field", () => {
  it("renders the field with a dialog-style combobox contract, not a listbox", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")]));
    renderField();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await settleDebounce();

    expect(input).toHaveAttribute("aria-haspopup", "dialog");
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    // Results are focusable cards, not options: the old roles must not come back.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("issues no request at all without a project", async () => {
    renderField({ projectId: undefined });
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    expect(fetchTaskPage).not.toHaveBeenCalled();
  });

  it("issues no request for a blank query", async () => {
    renderField({ query: "   " });
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    expect(fetchTaskPage).not.toHaveBeenCalled();
  });

  it("renders real cards instead of truncated suggestion rows", async () => {
    fetchTaskPage.mockResolvedValue(page([
      makeTask("FN-331", { title: "le bouton collapse du leftsidebar" }),
      makeTask("FN-332"),
    ]));
    const { container } = renderField();
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();

    await waitFor(() => expect(document.querySelectorAll(".task-search-result .card")).toHaveLength(2));
    expect(container.ownerDocument.querySelector(".task-search-suggestion")).toBeNull();
    expect(screen.getByText(/le bouton collapse du leftsidebar/)).toBeInTheDocument();
  });

  it("shows more than the former eight-result ceiling", async () => {
    fetchTaskPage.mockResolvedValue(page(
      Array.from({ length: 12 }, (_unused, index) => makeTask(`FN-${index}`)),
      null,
    ));
    renderField();
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();

    await waitFor(() => expect(document.querySelectorAll(".task-search-result")).toHaveLength(12));
  });

  it("finds a task by its description when it has no title", async () => {
    fetchTaskPage.mockResolvedValue(page([
      makeTask("FN-900", { title: undefined, description: "replier le panneau lateral gauche" }),
    ]));
    renderField();
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();

    await waitFor(() => expect(screen.getByText(/replier le panneau lateral gauche/)).toBeInTheDocument());
  });
});

describe("TaskSearchInput — Enter runs the AI lane", () => {
  it("calls the AI route on Enter and never the old highlighted-row selection", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1"), makeTask("FN-2")]));
    aiSearchTasks.mockResolvedValue({ query: "collapse", tasks: [makeTask("FN-9")] });
    const onSelectTask = vi.fn();
    const onSearchChange = vi.fn();
    renderField({ onSelectTask, onSearchChange });

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await settleDebounce();
    await waitFor(() => expect(document.querySelectorAll(".task-search-result")).toHaveLength(2));

    // Arrow into the panel first: even then, Enter in the FIELD must not select.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(aiSearchTasks).toHaveBeenCalledTimes(1);
    expect(aiSearchTasks.mock.calls[0][0]).toBe("collapse");
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it("runs no AI search for a blank query and none from typing", async () => {
    const { rerender } = renderField({ query: "c" });
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    rerender(
      <TaskSearchInput query="collapse" projectId="project-a" onSearchChange={() => undefined} />,
    );
    await settleDebounce();
    expect(aiSearchTasks).not.toHaveBeenCalled();

    rerender(<TaskSearchInput query="  " projectId="project-a" onSearchChange={() => undefined} />);
    await act(async () => { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }); });
    expect(aiSearchTasks).not.toHaveBeenCalled();
  });

  it("ignores an IME composition commit and an auto-repeated key", async () => {
    renderField();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);

    fireEvent.compositionStart(input);
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(aiSearchTasks).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    await act(async () => { fireEvent.keyDown(input, { key: "Enter", repeat: true }); });
    expect(aiSearchTasks).not.toHaveBeenCalled();
  });

  it("keeps the field typeable while a search is generating", async () => {
    aiSearchTasks.mockReturnValue(new Promise(() => undefined));
    const onSearchChange = vi.fn();
    renderField({ onSearchChange });

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "collapse encore" } });
    expect(onSearchChange).toHaveBeenCalledWith("collapse encore");
  });
});

describe("TaskSearchInput — selection and dismissal", () => {
  it("hands the selected task to the host without re-looking it up in a loaded collection", async () => {
    const remoteOnlyTask = makeTask("FN-OUT-OF-PAGE", { title: "Tâche hors page du tableau" });
    fetchTaskPage.mockResolvedValue(page([remoteOnlyTask]));
    const onSelectTask = vi.fn();
    renderField({ onSelectTask });

    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    await waitFor(() => expect(screen.getByText("FN-OUT-OF-PAGE")).toBeInTheDocument());

    fireEvent.click(screen.getByText("FN-OUT-OF-PAGE"));

    expect(onSelectTask).toHaveBeenCalledTimes(1);
    expect(onSelectTask.mock.calls[0][0].id).toBe("FN-OUT-OF-PAGE");
  });

  /*
  FNXC:TaskSearch 2026-09-17-07:43:
  FN-494 remplace le cas « applies the id to the caller's query when the host supplies no selection
  handler ». Ce contrat est supprimé : écrire l'identifiant de la tâche dans le champ est précisément
  le défaut signalé par l'opérateur. Le nouveau contrat est unique pour tous les hôtes : vider le
  champ, fermer le panneau, remonter la tâche.
  */
  it("(a1) vide le champ sans jamais y écrire l'identifiant, même sans gestionnaire de sélection", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-42")]));
    const onSearchChange = vi.fn();
    renderField({ onSearchChange });

    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    await waitFor(() => expect(screen.getByText("FN-42")).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByText("FN-42")); });

    expect(onSearchChange).toHaveBeenCalledWith("");
    expect(onSearchChange).not.toHaveBeenCalledWith("FN-42");
    for (const call of onSearchChange.mock.calls) expect(call[0]).toBe("");
    expect(screen.queryByTestId("task-search-results")).toBeNull();
  });

  it("(a2) remonte la tâche, vide le champ et ne laisse ni panneau ni référence ARIA pendante", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-42")]));
    const onSearchChange = vi.fn();
    const onSelectTask = vi.fn();
    renderField({ onSearchChange, onSelectTask });

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await settleDebounce();
    await waitFor(() => expect(screen.getByText("FN-42")).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByText("FN-42")); });

    expect(onSelectTask).toHaveBeenCalledTimes(1);
    expect(onSelectTask.mock.calls[0][0].id).toBe("FN-42");
    expect(onSearchChange).toHaveBeenCalledWith("");
    expect(onSearchChange).not.toHaveBeenCalledWith("FN-42");
    expect(screen.queryByTestId("task-search-results")).toBeNull();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(document.querySelector(".task-search-results")).toBeNull();
  });

  it.each(["Enter", " "] as const)("(a3) l'activation clavier %s d'une carte produit exactement le même triplet", async (key) => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-42")]));
    const onSearchChange = vi.fn();
    const onSelectTask = vi.fn();
    renderField({ onSearchChange, onSelectTask });

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await settleDebounce();
    await waitFor(() => expect(screen.getByText("FN-42")).toBeInTheDocument());

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const card = document.querySelector<HTMLElement>(".task-search-results .task-search-result .card");
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);

    await act(async () => { fireEvent.keyDown(card as HTMLElement, { key }); });

    expect(onSelectTask).toHaveBeenCalledTimes(1);
    expect(onSelectTask.mock.calls[0][0].id).toBe("FN-42");
    expect(onSearchChange).toHaveBeenCalledWith("");
    expect(onSearchChange).not.toHaveBeenCalledWith("FN-42");
    expect(screen.queryByTestId("task-search-results")).toBeNull();
  });

  it("(a4) une nouvelle saisie rouvre le panneau après une sélection", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-42")]));
    const onSelectTask = vi.fn();
    const { rerender } = renderField({ onSelectTask });

    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    await waitFor(() => expect(screen.getByText("FN-42")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText("FN-42")); });
    expect(screen.queryByTestId("task-search-results")).toBeNull();

    // La saisie est émise AVANT que l'hôte ne republie la requête : sur un champ contrôlé, réécrire
    // la valeur déjà rendue ne déclencherait aucun `change` React.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "collapse encore" } });
    rerender(
      <TaskSearchInput query="collapse encore" projectId="project-a" onSearchChange={() => undefined} onSelectTask={onSelectTask} />,
    );
    await settleDebounce();

    await waitFor(() => expect(screen.queryByTestId("task-search-results")).not.toBeNull());
  });

  it("closes on Escape and leaves no panel or dangling ARIA reference behind", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")]));
    renderField();
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await settleDebounce();
    await waitFor(() => expect(screen.queryByTestId("task-search-results")).not.toBeNull());

    await act(async () => { fireEvent.keyDown(input, { key: "Escape" }); });

    expect(screen.queryByTestId("task-search-results")).toBeNull();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input.getAttribute("aria-controls")).toBeNull();
  });

  it("does not treat a press inside the portalled panel as an outside press", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")]));
    renderField();
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    const panel = await screen.findByTestId("task-search-results");

    fireEvent.mouseDown(panel);

    expect(screen.queryByTestId("task-search-results")).not.toBeNull();
  });

  it("closes on a genuine outside press", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")]));
    render(
      <>
        <TaskSearchInput query="collapse" projectId="project-a" onSearchChange={() => undefined} />
        <button type="button">Dehors</button>
      </>,
    );
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    await waitFor(() => expect(screen.queryByTestId("task-search-results")).not.toBeNull());

    fireEvent.mouseDown(screen.getByText("Dehors"));

    await waitFor(() => expect(screen.queryByTestId("task-search-results")).toBeNull());
  });

  it("closes the panel and cancels work when Escape is pressed", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")]));
    const onClose = vi.fn();
    renderField({ onClose });
    fireEvent.focus(screen.getByRole("combobox"));
    await settleDebounce();
    await waitFor(() => expect(screen.queryByTestId("task-search-results")).not.toBeNull());

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("task-search-results")).toBeNull();
  });

  it("routes both lanes through the selected remote node", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")]));
    aiSearchTasks.mockResolvedValue({ query: "collapse", tasks: [] });
    renderField({ nodeId: "node-b", localNodeId: "local-1" });

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    await settleDebounce();
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    expect(fetchTaskPage.mock.calls[0][1]).toMatchObject({ nodeId: "node-b", localNodeId: "local-1" });
    expect(aiSearchTasks.mock.calls[0][1]).toMatchObject({ nodeId: "node-b", localNodeId: "local-1" });
  });
});

/*
FNXC:TaskSearch 2026-09-18-02:21:
FN-525 — la lane IA a désormais un bouton cliquable à la place de la croix de fermeture. L'invariant
couvert ici : le clic et la touche Entrée passent par le même déclencheur unique, le bouton refuse
une requête vide ou une recherche déjà en vol, il ne vole pas le focus du champ, et la fermeture de
la surface reste assurée par Échap chez l'hôte.
*/
describe("TaskSearchInput — bouton Search with AI", () => {
  it("rend le bouton même sans onClose et ne laisse aucune croix", () => {
    renderField();

    expect(screen.getByTestId("header-search-ai-btn")).toBeInTheDocument();
    expect(screen.queryByLabelText("Close search")).toBeNull();
    expect(document.querySelector(".header-search-clear")).toBeNull();
  });

  it("lance la recherche IA au clic et ouvre le panneau", async () => {
    aiSearchTasks.mockResolvedValue({ query: "collapse", tasks: [makeTask("FN-9")] });
    renderField();

    await act(async () => { fireEvent.click(screen.getByTestId("header-search-ai-btn")); });

    expect(aiSearchTasks).toHaveBeenCalledTimes(1);
    expect(aiSearchTasks.mock.calls[0][0]).toBe("collapse");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByTestId("task-search-results")).toBeInTheDocument();
  });

  it("emprunte le même chemin au clic et à la touche Entrée", async () => {
    aiSearchTasks.mockResolvedValue({ query: "collapse", tasks: [] });

    const clicked = renderField();
    await act(async () => { fireEvent.click(screen.getByTestId("header-search-ai-btn")); });
    const clickCalls = aiSearchTasks.mock.calls.map((call) => call[0]);
    clicked.unmount();

    aiSearchTasks.mockClear();
    renderField();
    await act(async () => { fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" }); });
    const enterCalls = aiSearchTasks.mock.calls.map((call) => call[0]);

    expect(clickCalls).toEqual(["collapse"]);
    expect(enterCalls).toEqual(clickCalls);
  });

  it.each(["", "   "])("désactive le bouton pour la requête %j et ne lance rien", async (query) => {
    renderField({ query });

    const button = screen.getByTestId("header-search-ai-btn");
    expect(button).toBeDisabled();
    await act(async () => { fireEvent.click(button); });

    expect(aiSearchTasks).not.toHaveBeenCalled();
  });

  it("refuse un second déclenchement pendant qu'une recherche IA est en vol", async () => {
    aiSearchTasks.mockReturnValue(new Promise(() => undefined));
    renderField();

    await act(async () => { fireEvent.click(screen.getByTestId("header-search-ai-btn")); });
    await waitFor(() => expect(screen.getByTestId("header-search-ai-btn")).toBeDisabled());
    await act(async () => { fireEvent.click(screen.getByTestId("header-search-ai-btn")); });

    expect(aiSearchTasks).toHaveBeenCalledTimes(1);
  });

  it("ne vole pas le focus du champ au mousedown", () => {
    renderField();
    const input = screen.getByRole("combobox");
    input.focus();

    fireEvent.mouseDown(screen.getByTestId("header-search-ai-btn"));

    expect(document.activeElement).toBe(input);
  });

  it("laisse Échap fermer la surface chez l'hôte", () => {
    const onClose = vi.fn();
    renderField({ onClose });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
    expect(screen.queryByTestId("task-search-results")).toBeNull();
  });

  it("ne déclenche ni sélection ni écriture dans le champ au clic", async () => {
    aiSearchTasks.mockResolvedValue({ query: "collapse", tasks: [] });
    const onSelectTask = vi.fn();
    const onSearchChange = vi.fn();
    renderField({ onSelectTask, onSearchChange });

    await act(async () => { fireEvent.click(screen.getByTestId("header-search-ai-btn")); });

    expect(onSelectTask).not.toHaveBeenCalled();
    expect(onSearchChange).not.toHaveBeenCalled();
  });
});
