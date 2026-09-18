import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Header, resolveReportContextRefs } from "../Header";

// Mock fetchScripts for overflow submenu
const mockFetchScripts = vi.fn();

/*
FNXC:TaskSearch 2026-09-17-09:41:
FN-477 made the header search own a real paginated collection and render real task cards, so this
file's API boundary is no longer just `fetchScripts`. Only the HTTP/session seams are doubled; the
Header, the field, the controller hook, and the cards are all production code here.
*/
const mockFetchTaskPage = vi.hoisted(() => vi.fn(async () => ({ tasks: [], total: 0, hasMore: false, nextCursor: null })));
const mockAiSearchTasks = vi.hoisted(() => vi.fn(async () => ({ query: "", tasks: [] })));

vi.mock("../../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
  fetchTaskPage: mockFetchTaskPage,
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
vi.mock("../../api/tasks/tasks-search", () => ({ aiSearchTasks: mockAiSearchTasks }));
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirmWithCheckbox: async (options?: { checkbox?: { defaultChecked?: boolean } }) => ({ choice: "cancel" as const, checkboxValue: options?.checkbox?.defaultChecked ?? false }), confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }),
}));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));

function searchPage(tasks: { id: string; title?: string; description?: string }[]) {
  return {
    tasks: tasks.map((task) => ({
      column: "todo",
      steps: [],
      dependencies: [],
      description: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...task,
    })),
    total: tasks.length,
    hasMore: false,
    nextCursor: null,
  };
}

const noop = () => {};

// Helper to mock mobile/tablet/desktop viewport
type ViewportTier = "mobile" | "tablet" | "desktop";

function mockMatchMedia(tier: ViewportTier) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      let matches = false;
      if (tier === "mobile" && query.includes("max-width: 768px")) {
        matches = true;
      } else if (tier === "tablet" && query.includes("769px")) {
        /*
        FNXC:TaskSearch 2026-09-17-09:41:
        Matched on the tablet LOWER bound only. FN-468 moved the upper bound from `1024px` to
        `1023.98px`, so the previous `includes("1024px")` clause silently stopped matching and every
        tablet-tier render in this file fell through to desktop — which is why 19 cases here were
        already red before FN-477 touched the file. The shared fixture is fixed once rather than
        per test, and it must not pin an exact query string again: the next boundary change would
        reintroduce exactly this silent drift.
        */
        matches = true;
      }
      // desktop: neither mobile nor tablet query matches
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function renderHeader(props = {}, tier: ViewportTier = "tablet") {
  mockMatchMedia(tier);
  return render(
    <Header
      onOpenSettings={noop}
      onOpenGitHubImport={noop}
      {...props}
    />
  );
}

function SearchHeaderHarness({
  tier: _tier,
  onQueryChange,
  onSelectSearchTask,
}: {
  tier: ViewportTier;
  onQueryChange?: (query: string) => void;
  onSelectSearchTask?: (task: { id: string }) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <Header
      onOpenSettings={noop}
      onOpenGitHubImport={noop}
      view="board"
      projectId="project-a"
      searchQuery={query}
      onSearchChange={(next: string) => { onQueryChange?.(next); setQuery(next); }}
      {...(onSelectSearchTask ? { onSelectSearchTask: onSelectSearchTask as never } : {})}
    />
  );
}

function renderSearchHeader(
  tier: ViewportTier,
  options: {
    onQueryChange?: (query: string) => void;
    onSelectSearchTask?: (task: { id: string }) => void;
  } = {},
) {
  mockMatchMedia(tier);
  return render(<SearchHeaderHarness tier={tier} {...options} />);
}

describe("Header", () => {
  it("garde Whiteboard hors du menu tant que son flag Alpha est désactivé", () => {
    const onChangeView = vi.fn();
    const disabled = renderHeader({ view: "board", onChangeView, experimentalFeatures: {} });
    fireEvent.click(screen.getByTitle("More views"));
    expect(screen.queryByTestId("view-overflow-whiteboard")).toBeNull();
    disabled.unmount();
    renderHeader({ view: "board", onChangeView, experimentalFeatures: { whiteboardView: true } });
    fireEvent.click(screen.getByTitle("More views"));
    const item = screen.getByTestId("view-overflow-whiteboard");
    expect(within(item).getByText("Alpha")).toBeInTheDocument();
    fireEvent.click(item);
    expect(onChangeView).toHaveBeenCalledWith("whiteboard");
  });
  it("derives report context from task hash routes and legacy query parameters", () => {
    expect(resolveReportContextRefs({ hash: "#/tasks/FN-8277", search: "?agentId=agent-1" })).toEqual({ taskId: "FN-8277", agentId: "agent-1" });
    expect(resolveReportContextRefs({ hash: "", search: "?taskId=FN-8277" })).toEqual({ taskId: "FN-8277", agentId: undefined });
    expect(resolveReportContextRefs({ hash: "#/command-center", search: "" })).toBeUndefined();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchScripts.mockResolvedValue({});
  });

  it("renders the logo and brand", () => {
    renderHeader();
    expect(screen.getByText("Fusion")).toBeDefined();
  });

  it("hides only the Fusion wordmark in the official mobile shell", () => {
    const mobile = renderHeader({ mobileNavEnabled: true }, "mobile");
    expect(screen.queryByText("Fusion")).toBeNull();
    expect(mobile.container.querySelector(".header-logo")).toBeInTheDocument();
    mobile.unmount();

    renderHeader({}, "tablet");
    expect(screen.getByText("Fusion")).toBeInTheDocument();
  });

  it("remplace la loupe Alpha desktop au même emplacement après le workflow", () => {
    const { container } = renderHeader({
      view: "board",
      leftSidebarNavActive: true,
      onChangeView: vi.fn(),
      searchQuery: "",
      onSearchChange: vi.fn(),
    }, "desktop");

    const actions = container.querySelector(".header-actions");
    const slot = screen.getByTestId("header-workflow-slot");
    const trigger = screen.getByTestId("desktop-inline-header-search-btn");
    const triggerIndex = Array.from(actions?.children ?? []).indexOf(trigger);
    expect(slot.parentElement).toBe(actions);
    expect(triggerIndex).toBeGreaterThan(Array.from(actions?.children ?? []).indexOf(slot));

    fireEvent.click(trigger);
    const inlineSearch = screen.getByTestId("desktop-header-search-input");
    expect(inlineSearch.parentElement).toBe(actions);
    expect(Array.from(actions?.children ?? []).indexOf(inlineSearch)).toBe(triggerIndex);
    expect(inlineSearch).toHaveClass("header-search--inline");
    expect(screen.getByRole("combobox", { name: "Search tasks..." })).toHaveFocus();
    expect(screen.queryByTestId("desktop-inline-header-search-btn")).toBeNull();
    expect(screen.queryByTestId("alpha-task-search-overlay")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Search tasks..." })).toBeNull();
  });

  /*
  FNXC:TaskSearch 2026-09-17-09:41:
  FN-477 rewrote this case. It used to prove an OPTION inside a LISTBOX, sourced from the collection
  the board had already loaded, could be clicked. Both halves are gone: results are cards fetched by
  the field itself, so the interesting property is now that a task the board never loaded reaches the
  host — which is exactly what the old collection lookup made impossible.
  */
  it.each(["board", "list"] as const)("ouvre le panneau Alpha desktop sur %s sans modifier le filtre", async (view) => {
    mockFetchTaskPage.mockResolvedValue(searchPage([{ id: "FN-353", title: "Alpha shell" }]) as never);
    const onSearchChange = vi.fn();
    const onSelectSearchTask = vi.fn();
    renderHeader({ view, projectId: "project-a", searchQuery: "alpha", onSearchChange, onSelectSearchTask }, "desktop");
    expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    const input = screen.getByRole("combobox", { name: "Search tasks..." });
    fireEvent.change(input, { target: { value: "353" } });

    await waitFor(() => expect(screen.getByText("FN-353")).toBeInTheDocument());
    // Cards, not options.
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByText("FN-353"));

    expect(onSelectSearchTask).toHaveBeenCalledTimes(1);
    expect(onSelectSearchTask.mock.calls[0][0].id).toBe("FN-353");
    // The desktop host's transient query never touches the Board/List filter.
    expect(onSearchChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: "Search tasks..." })).toBeNull();
    expect(screen.queryByTestId("alpha-task-search-overlay")).toBeNull();
    expect(document.querySelector(".task-search-results")).toBeNull();
    /*
    FNXC:TaskSearch 2026-09-17-07:43:
    FN-494 — (c1). L'ancienne assertion exigeait que le déclencheur reprenne le focus après une
    SÉLECTION. Elle encodait précisément le défaut : la fiche de tâche vient de s'ouvrir et se faisait
    voler le focus une frame plus tard. Close et Escape restaurent toujours le focus (cas suivant).
    */
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).not.toBe(screen.getByTestId("desktop-inline-header-search-btn"));
  });

  it.each([
    { name: "vide", tasks: [] as { id: string; title: string }[] },
    { name: "sans correspondance", tasks: [] as { id: string; title: string }[] },
  ])("garde le combobox Alpha utilisable avec une réponse $name", async ({ tasks }) => {
    mockFetchTaskPage.mockResolvedValue(searchPage(tasks) as never);
    renderHeader({ view: "board", projectId: "project-a", onSearchChange: vi.fn() }, "desktop");
    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    const input = screen.getByRole("combobox", { name: "Search tasks..." });
    fireEvent.change(input, { target: { value: "353" } });

    // An empty answer shows the panel's empty state; it never resurrects a listbox.
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.queryByTestId("alpha-task-search-overlay")).toBeNull();
    expect(input).toBeEnabled();
  });

  it("ferme et réinitialise le champ Alpha desktop par Escape", async () => {
    renderHeader({ view: "board", projectId: "project-a", onSearchChange: vi.fn() }, "desktop");

    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "353" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search tasks..." }), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("desktop-inline-header-search-btn")).toHaveFocus());

    fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    expect(screen.getByRole("combobox", { name: "Search tasks..." })).toHaveValue("");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search tasks..." }), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("desktop-inline-header-search-btn")).toHaveFocus());
    expect(screen.queryByTestId("alpha-task-search-overlay")).toBeNull();
  });

  /*
  FNXC:TaskSearch 2026-09-18-02:21:
  FN-525 — les trois hôtes de recherche du header doivent rendre le bouton « Search with AI » et
  déclencher la même lane IA que la touche Entrée, là où la croix de fermeture se trouvait.
  */
  it.each(["desktop", "tablet", "mobile"] as const)("déclenche la recherche IA depuis le bouton Search with AI sur %s", async (tier) => {
    renderSearchHeader(tier);
    if (tier === "desktop") fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
    else if (tier === "tablet") fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
    else fireEvent.click(screen.getByTestId("mobile-header-search-btn"));

    fireEvent.change(screen.getByRole("combobox", { name: "Search tasks..." }), { target: { value: "353" } });
    const button = screen.getByTestId("header-search-ai-btn");
    expect(button).toBeEnabled();
    await act(async () => { fireEvent.click(button); });

    await waitFor(() => expect(mockAiSearchTasks).toHaveBeenCalledTimes(1));
    expect(mockAiSearchTasks.mock.calls[0][0]).toBe("353");
    expect(screen.queryByLabelText("Close search")).toBeNull();
  });

  it.each(["desktop", "tablet", "mobile"] as const)("ne rend jamais le hamburger Alpha dans le Header sur %s", (tier) => {
    renderHeader({ mobileNavEnabled: true }, tier);
    expect(screen.queryByTestId("mobile-menu-trigger")).toBeNull();
  });

  it.each(["desktop", "tablet", "mobile"] as const)("does not render the relocated Report affordance in the %s header", (tier) => {
    renderHeader({}, tier);
    expect(screen.queryByRole("button", { name: "Report" })).toBeNull();
    expect(screen.queryByText("Report bug")).toBeNull();
  });

  it("applies shell host metadata on the header root", () => {
    const { container } = renderHeader({ shellHost: { kind: "desktop-shell", mode: "remote", canOpenConnectionManager: true } });
    expect(container.querySelector("header.header")?.getAttribute("data-shell-kind")).toBe("desktop-shell");
  });

  it("renders shell connection control when provided", () => {
    renderHeader({ shellConnectionControl: <button type="button">Manage connections</button> });
    expect(screen.getByRole("button", { name: "Manage connections" })).toBeInTheDocument();
  });

  it("does not render shell connection control when omitted", () => {
    const { container } = renderHeader({ shellConnectionControl: undefined });
    expect(container.querySelector(".shell-connection-status")).toBeNull();
  });

  it("keeps moved desktop actions out of the official Header", () => {
    renderHeader({ leftSidebarNavActive: true }, "desktop");
    expect(screen.queryByTitle("Import from GitHub")).toBeNull();
    expect(screen.queryByTitle("Settings")).toBeNull();
  });

  describe("workflows button", () => {
    it("renders the desktop workflows button and opens the editor on click", () => {
      const onOpenWorkflowEditor = vi.fn();
      renderHeader({ onOpenWorkflowEditor }, "desktop");
      const btn = screen.getByTestId("workflow-steps-btn");
      expect(btn.getAttribute("title")).toBe("Workflows");
      fireEvent.click(btn);
      expect(onOpenWorkflowEditor).toHaveBeenCalledTimes(1);
    });

    it("opens the editor from the mobile overflow menu", () => {
      const onOpenWorkflowEditor = vi.fn();
      renderHeader({ onOpenWorkflowEditor }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-workflow-steps-btn"));
      expect(onOpenWorkflowEditor).toHaveBeenCalledTimes(1);
    });
  });

  it("hides GitHub import for desktop shell host", () => {
    renderHeader({ shellHost: { kind: "desktop-shell" } });
    expect(screen.queryByTitle("Import from GitHub")).toBeNull();
  });

  it("keeps GitHub import in compact overflow for mobile shell host", () => {
    renderHeader({ shellHost: { kind: "mobile-shell" } }, "mobile");
    fireEvent.click(screen.getByTitle("More header actions"));
    expect(screen.getByText("Import from GitHub")).toBeDefined();
  });

  it("calls onOpenSettings from the compact overflow", () => {
    const onOpenSettings = vi.fn();
    renderHeader({ onOpenSettings }, "mobile");
    fireEvent.click(screen.getByTitle("More header actions"));
    fireEvent.click(screen.getByText("Settings"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  /*
  FNXC:Navigation 2026-09-14-19:51:
  Exemption marker for FN-397. The Header's mobile overflow menu is not affected by the popover scroll reset because it
  emits no opening focus at all; freeze that so a future auto-focus cannot silently reintroduce a scroll-resetting
  focus() on a menu surface.
  */
  it("emits no focus call when the mobile overflow menu opens", () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      renderHeader({ onOpenSettings: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Settings")).toBeDefined();
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      focusSpy.mockRestore();
    }
  });

  it("does not render the desktop files button", () => {
    renderHeader({ onOpenFiles: vi.fn() }, "desktop");
    expect(screen.queryByTestId("files-toggle-btn")).toBeNull();
  });

  it("does not render the desktop GitHub import button", () => {
    renderHeader({ onOpenGitHubImport: vi.fn() }, "desktop");
    expect(screen.queryByTitle("Import from GitHub")).toBeNull();
  });

  it("does not render the desktop Git Manager button", () => {
    renderHeader({ onOpenGitManager: noop, stashOrphanCount: 5 }, "desktop");
    expect(screen.queryByTestId("git-manager-btn")).toBeNull();
  });

  it("shows the stash orphan badge on the compact Git Manager overflow item", () => {
    renderHeader({ onOpenGitManager: noop, stashOrphanCount: 6 }, "mobile");
    fireEvent.click(screen.getByTitle("More header actions"));
    const item = screen.getByTestId("overflow-git-btn");
    expect(item).toHaveTextContent("Git Manager");
    expect(item.querySelector(".btn-badge")?.textContent).toBe("6");
  });

  describe("view toggle", () => {
    /*
     * FN-426 moved Activity and Notes out of the right dock into header panels; FN-437 narrows their Header producer to
     * tablet/desktop, because on phone the footer navigation menu already owns both destinations. The Header still owns
     * the triggers, their anchor rect, and their accessible expanded/controls relationship on those two tiers.
     */
    it.each(["tablet", "desktop"] as const)("renders the Activity and Notes panel triggers on %s", (mode) => {
      const onOpenActivityPanel = vi.fn();
      const onOpenNotesPanel = vi.fn();
      renderHeader({ onChangeView: noop, onOpenActivityPanel, onOpenNotesPanel, activityPanelId: "a", notesPanelId: "n" }, mode);

      const activity = screen.getByTestId("header-activity-panel-btn");
      const notes = screen.getByTestId("header-notes-panel-btn");
      expect(activity).toHaveAttribute("aria-expanded", "false");
      expect(activity).not.toHaveAttribute("aria-controls");
      activity.click();
      notes.click();
      expect(onOpenActivityPanel).toHaveBeenCalledTimes(1);
      expect(onOpenActivityPanel.mock.calls[0][0]).toBeTruthy();
      expect(onOpenNotesPanel).toHaveBeenCalledTimes(1);
    });

    /*
     * FN-437 cas (c) : sur téléphone, le menu du pied de page est le propriétaire UNIQUE d'Activité et de Notes, donc le
     * Header n'en rend aucun déclencheur — ni nœud, ni coquille de bouton vide, ni `aria-controls` orphelin.
     */
    it("ne rend aucun déclencheur Activity/Notes sur téléphone et ne laisse pas de coquille vide", () => {
      const onOpenActivityPanel = vi.fn();
      const onOpenNotesPanel = vi.fn();
      const { container } = renderHeader(
        {
          onChangeView: noop,
          onOpenActivityPanel,
          onOpenNotesPanel,
          activityPanelId: "dashboard-activity-panel",
          notesPanelId: "dashboard-notes-panel",
          activityPanelOpen: true,
        },
        "mobile",
      );

      expect(screen.queryByTestId("header-activity-panel-btn")).toBeNull();
      expect(screen.queryByTestId("header-notes-panel-btn")).toBeNull();
      expect(container.querySelector('[aria-controls="dashboard-activity-panel"]')).toBeNull();
      expect(container.querySelector('[aria-controls="dashboard-notes-panel"]')).toBeNull();
      expect(onOpenActivityPanel).not.toHaveBeenCalled();
      expect(onOpenNotesPanel).not.toHaveBeenCalled();

      // Aucun bouton résiduel sans icône ni libellé ne doit subsister dans la rangée d'actions.
      const actions = container.querySelector(".header-actions");
      for (const button of Array.from(actions?.querySelectorAll("button") ?? [])) {
        const hasIcon = button.querySelector("svg") !== null;
        const hasLabel = (button.textContent ?? "").trim().length > 0;
        expect(hasIcon || hasLabel).toBe(true);
      }
    });

    it("advertises the open panel through aria-expanded and aria-controls", () => {
      renderHeader({ onChangeView: noop, onOpenActivityPanel: vi.fn(), activityPanelOpen: true, activityPanelId: "dashboard-activity-panel" });
      const activity = screen.getByTestId("header-activity-panel-btn");
      expect(activity).toHaveAttribute("aria-expanded", "true");
      expect(activity).toHaveAttribute("aria-controls", "dashboard-activity-panel");
    });

    it("renders no panel trigger shell when its opener is absent", () => {
      renderHeader({ onChangeView: noop });
      expect(screen.queryByTestId("header-activity-panel-btn")).toBeNull();
      expect(screen.queryByTestId("header-notes-panel-btn")).toBeNull();
    });

    it("does not render view toggle when onChangeView is not provided", () => {
      renderHeader();
      expect(screen.queryByTitle("Board view")).toBeNull();
      expect(screen.queryByTitle("List view")).toBeNull();
    });

    /*
    FN-426 supersedes FN-382's dock-only List: the right dock is optional, so the header offers Board AND List on
    every breakpoint. Otherwise an operator who leaves the dock off would have no way to browse tasks as a list.
    */
    it("renders both Board and List toggles when onChangeView is provided", () => {
      renderHeader({ onChangeView: noop });
      expect(screen.getByTitle("Board view")).toBeDefined();
      expect(screen.getByTitle("List view")).toBeDefined();
    });

    /*
     * FN-437 cas (a) : le groupe `view-toggle` reste rendu sur téléphone (Board et ses autres destinations), mais son
     * bouton List disparaît parce que l'entrée `mobile-more-item-list` du menu du pied de page en est désormais le
     * propriétaire unique. Remplaçant du test FN-426 « keeps the List toggle on the phone host ».
     */
    it("retire le bouton List du groupe view-toggle sur téléphone en gardant Board", () => {
      renderHeader({ onChangeView: noop }, "mobile");
      expect(screen.getByTitle("Board view")).toBeDefined();
      expect(screen.queryByTitle("List view")).toBeNull();
      expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
    });

    /*
     * FN-437 cas (b) : l'invariant « aucun `header-list-view-btn` quand `isMobile` » est inconditionnel — il tient aussi
     * quand le pied de page ou la barre latérale supprime le groupe et que seul le producteur autonome resterait.
     */
    it("ne rend aucun bouton List sur téléphone même quand une surface large supprime le groupe", () => {
      renderHeader({ onChangeView: noop, mobileNavEnabled: true, leftSidebarNavActive: true }, "mobile");
      expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
    });

    /*
     * FN-439 cas (d) : sur tablette et ordinateur, la navigation large possède désormais List (menu **More** du pied
     * de page, ou barre latérale). Le Header n'en est plus le producteur : le bouton autonome de `header-actions` a
     * disparu. Remplace le contrat FN-426 « garde exactement un bouton List sur %s ».
     */
    it.each(["tablet", "desktop"] as const)("ne rend aucun bouton List sur %s quand une surface large possède la navigation", (mode) => {
      const rendered = renderHeader({ onChangeView: noop, leftSidebarNavActive: true, view: "board" }, mode);
      expect(screen.queryByTestId("header-list-view-btn")).toBeNull();

      rendered.unmount();
      renderHeader({ onChangeView: noop, leftSidebarNavActive: true, view: "list" }, mode);
      expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
    });

    /*
     * FN-439 cas (e) : après le retrait, `.header-actions` ne doit garder ni coquille de bouton vide ni nœud de slot
     * workflow orphelin sur une vue qui n'est ni Board ni List.
     */
    it.each(["tablet", "desktop"] as const)("ne laisse ni bouton vide ni slot workflow résiduel sur %s", (mode) => {
      const { container } = renderHeader({ onChangeView: noop, leftSidebarNavActive: true, view: "missions" }, mode);
      const actions = container.querySelector(".header-actions")!;
      for (const button of actions.querySelectorAll("button")) {
        const hasIcon = button.querySelector("svg") !== null;
        const hasLabel = (button.textContent ?? "").trim().length > 0;
        expect(hasIcon || hasLabel).toBe(true);
      }
      expect(document.querySelector(".header-workflow-slot")).toBeNull();
      expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
    });

    /* FN-426: the List button is a toggle — it returns to the Board when the List route is already on screen. */
    it("toggles between Board and List through onChangeView", async () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "board" });
      screen.getByTestId("header-list-view-btn").click();
      expect(onChangeView).toHaveBeenLastCalledWith("list");

      cleanup();
      renderHeader({ onChangeView, view: "list" });
      screen.getByTestId("header-list-view-btn").click();
      expect(onChangeView).toHaveBeenLastCalledWith("board");
    });

    /*
     * FN-426: the view-toggle GROUP stays suppressed while a wide navigation surface owns routing, but Board/List
     * keeps exactly one standalone header producer there — otherwise FN-382's removal of List from that navigation
     * would leave the destination unreachable for operators who turn the optional right sidebar off.
     */
    it.each(["desktop", "tablet"] as const)(
      "renders the workflow portal slot and no List producer at all on %s sidebar nav",
      (mode) => {
        renderHeader({ onChangeView: noop, leftSidebarNavActive: true, view: "board" }, mode);
        expect(screen.getByTestId("header-workflow-slot")).toBeInTheDocument();
        expect(screen.queryByTitle("Board view")).toBeNull();
        expect(screen.queryByTestId("view-toggle-command-center")).toBeNull();
        expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
      },
    );

    /*
     * FN-439 cas (a) : le slot workflow n'appartient qu'à Board et List. Sur toute autre destination le nœud disparaît
     * complètement (aucun conteneur, aucune classe résiduelle), ce qui suffit à masquer le sélecteur puisque les quatre
     * consommateurs du portail retournent `null` sans slot.
     */
    it.each(["tablet", "desktop"] as const)("ne rend le slot workflow que sur board et list en %s", (mode) => {
      for (const view of ["board", "list"] as const) {
        const rendered = renderHeader({ onChangeView: noop, leftSidebarNavActive: true, view }, mode);
        expect(screen.getByTestId("header-workflow-slot")).toBeInTheDocument();
        rendered.unmount();
      }

      for (const view of ["missions", "planning", "command-center"] as const) {
        const rendered = renderHeader({ onChangeView: noop, leftSidebarNavActive: true, view }, mode);
        expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
        expect(document.querySelector(".header-workflow-slot")).toBeNull();
        rendered.unmount();
      }
    });

    /*
     * FN-439 cas (b) : même contrat pour le producteur mobile de `header-left`, SANS Board de fond.
     *
     * FNXC:WorkflowControls 2026-09-16-23:24:
     * FN-483 : ce cas reste le contrat de la route seule. Le contexte de Board de fond est couvert juste en dessous.
     */
    it("ne rend le slot workflow mobile que sur board et list sans Board de fond", () => {
      for (const view of ["board", "list"] as const) {
        const rendered = renderHeader({ onChangeView: noop, mobileNavEnabled: true, view }, "mobile");
        expect(screen.getByTestId("header-workflow-slot")).toHaveClass("header-workflow-slot--mobile");
        rendered.unmount();
      }

      renderHeader({ onChangeView: noop, mobileNavEnabled: true, view: "missions" }, "mobile");
      expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
      expect(document.querySelector(".header-workflow-slot")).toBeNull();
    });

    /*
     * FN-483 : le symptôme d'origine. Sur téléphone, le Board reste actif derrière chaque drawer, donc le slot doit
     * survivre au changement de destination — même nœud DOM avant, pendant et après — sinon le Board replie son
     * sélecteur en ligne sous le header.
     */
    it("garde le même nœud de slot pendant que la destination change au-dessus d'un Board de fond", () => {
      function BackgroundBoardHeaderHarness() {
        const [view, setView] = useState<"board" | "command-center" | "list" | "planning">("board");
        return (
          <>
            <button data-testid="go-command-center" onClick={() => setView("command-center")} />
            <button data-testid="go-list" onClick={() => setView("list")} />
            <button data-testid="go-planning" onClick={() => setView("planning")} />
            <button data-testid="go-board" onClick={() => setView("board")} />
            <Header
              onOpenSettings={noop}
              onOpenGitHubImport={noop}
              onChangeView={noop}
              mobileNavEnabled
              boardBackgroundActive
              view={view}
            />
          </>
        );
      }

      mockMatchMedia("mobile");
      render(<BackgroundBoardHeaderHarness />);
      const initialSlot = screen.getByTestId("header-workflow-slot");

      for (const destination of ["go-command-center", "go-list", "go-planning", "go-board"] as const) {
        fireEvent.click(screen.getByTestId(destination));
        expect(screen.getAllByTestId("header-workflow-slot")).toHaveLength(1);
        expect(screen.getByTestId("header-workflow-slot")).toBe(initialSlot);
        expect(initialSlot.isConnected).toBe(true);
      }
    });

    /* FN-483 : le contexte de fond ne s'applique pas aux vraies pages tablette/ordinateur. */
    it.each(["tablet", "desktop"] as const)("ignore le contexte de Board de fond sur une vraie page %s", (mode) => {
      renderHeader({ onChangeView: noop, leftSidebarNavActive: true, view: "missions", boardBackgroundActive: true }, mode);
      expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
      expect(document.querySelector(".header-workflow-slot")).toBeNull();
    });

    /*
    FNXC:WorkflowControls 2026-09-17-02:14:
    FN-481 : symptôme d'origine — « en vue tablette le sélecteur de projet se met à droite du sélecteur de workflow ».
    La tablette garde la pill, donc `hideFullNav` y est vrai, mais son Header doit rester organisé comme l'ordinateur :
    sélecteur de projet dans `header-left`, slot peuplé dans `header-actions`, et ordre DOM projet → workflow →
    recherche. Le test monte un vrai portail dans le slot pour que le placement soit prouvé sur un nœud peuplé.
    */
    it.each([
      ["tablet", "board"],
      ["tablet", "list"],
      ["desktop", "board"],
      ["desktop", "list"],
    ] as const)("garde la disposition ordinateur du slot workflow en %s sur %s", (mode, slotView) => {
      const { container } = renderHeader(
        {
          onChangeView: noop,
          /* Tablette : shell réel (pill propriétaire, pas de colonne de gauche). Ordinateur : navigation large. */
          mobileNavEnabled: mode === "tablet",
          leftSidebarNavActive: mode === "desktop",
          view: slotView,
          projects: [{ id: "p1", name: "Projet un", path: "/p1" }],
          currentProject: { id: "p1", name: "Projet un", path: "/p1" },
          onViewAllProjects: noop,
          onSelectProject: noop,
          onSearchChange: noop,
          projectId: "p1",
        },
        mode,
      );

      const slots = screen.getAllByTestId("header-workflow-slot");
      expect(slots).toHaveLength(1);
      const slot = slots[0]!;
      expect(slot).not.toHaveClass("header-workflow-slot--mobile");
      expect(slot.closest(".header-actions")).not.toBeNull();
      expect(slot.closest(".header-left")).toBeNull();

      /* Portail réel : un slot vide serait masqué par `:empty` et ne prouverait aucun ordre visible. */
      const populated = document.createElement("div");
      populated.className = "board-workflow-toolbar";
      populated.dataset.testid = "portal-workflow-control";
      slot.appendChild(populated);

      const projectTrigger = screen.getByTestId("project-selector-trigger");
      expect(projectTrigger.closest(".header-left")).not.toBeNull();
      const searchControl = container.querySelector<HTMLElement>(".header-actions [data-testid$=\"header-search-btn\"], .header-actions [data-testid$=\"header-search-input\"]");
      expect(searchControl).not.toBeNull();

      const projectBeforeSlot = projectTrigger.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(projectBeforeSlot).toBeTruthy();
      const slotBeforeSearch = slot.compareDocumentPosition(searchControl!) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(slotBeforeSearch).toBeTruthy();
    });

    /* FN-481 : la disposition compacte reste réservée au téléphone et n'apparaît pas sur tablette. */
    it("ne rend aucun slot workflow compact sur tablette", () => {
      renderHeader({ onChangeView: noop, mobileNavEnabled: true, view: "board" }, "tablet");
      expect(document.querySelector(".header-workflow-slot--mobile")).toBeNull();
      expect(screen.getAllByTestId("header-workflow-slot")).toHaveLength(1);
    });

    /* FN-481 : aucun slot orphelin sur une vue sans workflow, quel que soit le mode compact. */
    it.each(["mobile", "tablet"] as const)("ne laisse aucun slot résiduel sur une vue sans workflow en %s", (mode) => {
      renderHeader({ onChangeView: noop, mobileNavEnabled: true, view: "missions" }, mode);
      expect(screen.queryByTestId("header-workflow-slot")).toBeNull();
      expect(document.querySelector(".header-workflow-slot")).toBeNull();
    });

    it("renders the workflow portal slot in the mobile top header when mobile nav owns view switching", () => {
      renderHeader({ onChangeView: noop, leftSidebarNavActive: true, mobileNavEnabled: true }, "mobile");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      expect(workflowSlot).toBeInTheDocument();
      expect(workflowSlot).toHaveClass("header-workflow-slot--mobile");
      expect(workflowSlot.closest(".header-left")).toBeInTheDocument();
      expect(screen.queryByTestId("mobile-view-toggle")).toBeNull();
      expect(screen.queryByTestId("mobile-view-toggle-board")).toBeNull();
      expect(screen.queryByTestId("mobile-view-toggle-list")).toBeNull();
    });

    it("renders one mobile New Task action only for an active project callback", () => {
      const onNewTask = vi.fn();
      const rendered = renderHeader({ mobileNavEnabled: true, projectId: "project-1", onNewTask }, "mobile");
      fireEvent.click(screen.getByTestId("mobile-header-new-task"));
      expect(onNewTask).toHaveBeenCalledOnce();

      rendered.unmount();
      renderHeader({ mobileNavEnabled: true, onNewTask }, "mobile");
      expect(screen.queryByTestId("mobile-header-new-task")).toBeNull();
    });

    it("keeps the mobile New Task action last and after search and usage", () => {
      const { container } = renderHeader({
        mobileNavEnabled: true,
        projectId: "project-1",
        onNewTask: vi.fn(),
        onSearchChange: vi.fn(),
        onOpenUsage: vi.fn(),
      }, "mobile");

      const actions = container.querySelector(".header-actions");
      const newTask = screen.getByTestId("mobile-header-new-task");
      const search = screen.getByTestId("mobile-header-search-btn");
      const usage = screen.getByTestId("mobile-header-usage-btn");
      const children = Array.from(actions?.children ?? []);

      expect(actions?.lastElementChild).toBe(newTask);
      expect(children.indexOf(search)).toBeLessThan(children.indexOf(newTask));
      expect(children.indexOf(usage)).toBeLessThan(children.indexOf(newTask));
      expect(screen.getAllByTestId("mobile-header-new-task")).toHaveLength(1);
      expect(actions?.firstElementChild).not.toBe(newTask);
      expect(actions?.firstElementChild?.matches("button.btn-icon")).toBe(true);
      expect(actions?.firstElementChild?.querySelector("svg")).not.toBeNull();
    });

    /*
     * FN-437 cas (e) : remplaçant du test « keeps the retired desktop Header New Task action absent… ». La création ne
     * doit plus dépendre de l'écran affiché, donc le Header — seule surface présente partout — expose désormais cette
     * action sur ordinateur aussi.
     */
    it("rend l'action New Task du Header sur ordinateur et l'appelle au clic", () => {
      const onNewTask = vi.fn();
      renderHeader({ projectId: "project-1", onNewTask }, "desktop");
      const action = screen.getByTestId("mobile-header-new-task");
      expect(action).toHaveClass("view-action-button", "view-action-button--create");
      fireEvent.click(action);
      expect(onNewTask).toHaveBeenCalledOnce();
    });

    /*
     * FN-437 cas (g) : l'action reste unique et dernière dans la rangée d'actions sur ordinateur — le retour de cette
     * affordance ne doit ni créer de doublon dans `header-actions` ni se glisser avant les autres contrôles.
     */
    it("garde une seule action New Task, en dernier, dans header-actions sur ordinateur", () => {
      const { container } = renderHeader(
        { projectId: "project-1", onNewTask: vi.fn(), onChangeView: noop, onSearchChange: vi.fn() },
        "desktop",
      );
      const action = screen.getByTestId("mobile-header-new-task");
      expect(screen.getAllByRole("button", { name: "New Task" })).toHaveLength(1);
      expect(screen.getAllByTestId("mobile-header-new-task")).toHaveLength(1);
      expect(container.querySelector(".header-actions")?.lastElementChild).toBe(action);
    });

    it.each(["tablet", "mobile"] as const)("builds the %s New Task action from the shared create primitive", (tier) => {
      const onNewTask = vi.fn();
      renderHeader({ projectId: "project-1", onNewTask }, tier);
      const action = screen.getByTestId("mobile-header-new-task");
      expect(action).toHaveClass("view-action-button", "view-action-button--create");
      fireEvent.click(action);
      expect(onNewTask).toHaveBeenCalledOnce();
    });

    /*
     * FN-437 cas (f) : remplaçant du test « suppresses the global New Task action when List owns… ». Sur ordinateur
     * l'action est présente pour TOUTES les vues, y compris `list` — la demande est explicite « peu importe la vue »,
     * et le bouton propre à `ListView` (conscient du workflow sélectionné) vit dans une autre barre. Sous ordinateur le
     * comportement compact est inchangé : `list` reste exclue.
     */
    it("rend l'action New Task en vue list sur ordinateur et la retire en compact", () => {
      const onNewTask = vi.fn();
      const desktop = renderHeader({ projectId: "project-1", view: "list", onNewTask }, "desktop");
      const action = screen.getByTestId("mobile-header-new-task");
      fireEvent.click(action);
      expect(onNewTask).toHaveBeenCalledOnce();
      desktop.unmount();

      for (const tier of ["tablet", "mobile"] as const) {
        const compact = renderHeader({ projectId: "project-1", view: "list", onNewTask }, tier);
        expect(screen.queryByTestId("mobile-header-new-task")).toBeNull();
        compact.unmount();
      }
    });

    it.each(["tablet", "mobile"] as const)("renders one functional Alpha New Task action last at the %s tier", (tier) => {
      const onNewTask = vi.fn();
      const { container } = renderHeader({ projectId: "project-1", onNewTask }, tier);
      const action = screen.getByTestId("mobile-header-new-task");
      expect(container.querySelector(".header-actions")?.lastElementChild).toBe(action);
      expect(screen.getAllByRole("button", { name: "New Task" })).toHaveLength(1);
      fireEvent.click(action);
      expect(onNewTask).toHaveBeenCalledOnce();
    });

    it.each(["desktop", "tablet", "mobile"] as const)("omits the Alpha New Task action without project or callback at the %s tier", (tier) => {
      const rendered = renderHeader({ onNewTask: vi.fn() }, tier);
      expect(screen.queryByTestId("mobile-header-new-task")).toBeNull();
      rendered.unmount();
      renderHeader({ projectId: "project-1" }, tier);
      expect(screen.queryByTestId("mobile-header-new-task")).toBeNull();
    });

    // FN-437 : la paire Board/List n'existe plus ensemble sur téléphone, ces cas d'état actif passent donc sur tablette.
    it("shows board view as active by default", () => {
      renderHeader({ onChangeView: noop }, "tablet");
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.className).toContain("active");
      expect(listBtn.className).not.toContain("active");
    });

    it("shows list view as active when view is 'list'", () => {
      renderHeader({ onChangeView: noop, view: "list" }, "tablet");
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.className).not.toContain("active");
      expect(listBtn.className).toContain("active");
    });

    it("calls onChangeView with 'board' when clicking board view button", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "list" });
      fireEvent.click(screen.getByTitle("Board view"));
      expect(onChangeView).toHaveBeenCalledWith("board");
    });

    it("calls onChangeView with 'list' when clicking list view button", () => {
      const onChangeView = vi.fn();
      // FN-437 : le bouton List du Header n'existe plus sur téléphone ; le contrat de clic se vérifie sur tablette.
      renderHeader({ onChangeView, view: "board" }, "tablet");
      fireEvent.click(screen.getByTitle("List view"));
      expect(onChangeView).toHaveBeenCalledWith("list");
    });

    it("shows chat unread indicator when chatHasUnreadResponse is true and chat is not active", () => {
      renderHeader({ onChangeView: noop, view: "board", chatHasUnreadResponse: true });
      expect(screen.getByLabelText("Unread chat response")).toBeInTheDocument();
    });

    it("shows mailbox unread indicator when there are unread messages only", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxUnreadCount: 3, mailboxPendingApprovalCount: 0 });
      expect(screen.getByLabelText("3 unread messages")).toBeInTheDocument();
      expect(screen.queryByLabelText("Pending approvals")).toBeNull();
    });

    it("shows mailbox pending-approval indicator when mailbox is not active", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxPendingApprovalCount: 2, mailboxUnreadCount: 0 });
      expect(screen.getByLabelText("Pending approvals")).toBeInTheDocument();
      expect(screen.queryByLabelText(/unread messages/)).toBeNull();
    });

    it("shows only the pending indicator when mailbox has both pending approvals and unread messages", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxPendingApprovalCount: 2, mailboxUnreadCount: 4 });
      expect(screen.getByLabelText("Pending approvals")).toBeInTheDocument();
      expect(screen.queryByLabelText("4 unread messages")).toBeNull();
    });

    it("hides mailbox indicators when counts are zero", () => {
      renderHeader({ onChangeView: noop, view: "board", mailboxPendingApprovalCount: 0, mailboxUnreadCount: 0 });
      expect(screen.queryByLabelText("Pending approvals")).toBeNull();
      expect(screen.queryByLabelText(/unread messages/)).toBeNull();
    });

    it("hides mailbox indicators when mailbox view is active", () => {
      renderHeader({ onChangeView: noop, view: "mailbox", mailboxPendingApprovalCount: 2, mailboxUnreadCount: 3 });
      expect(screen.queryByLabelText("Pending approvals")).toBeNull();
      expect(screen.queryByLabelText(/unread messages/)).toBeNull();
    });

    it("hides chat unread indicator when chat view is active", () => {
      renderHeader({ onChangeView: noop, view: "chat", chatHasUnreadResponse: true });
      expect(screen.queryByLabelText("Unread chat response")).toBeNull();
    });

    it("has correct aria attributes for accessibility", () => {
      // FN-437 : la paire Board/List coexiste sur tablette/ordinateur uniquement.
      renderHeader({ onChangeView: noop, view: "board" }, "tablet");
      const boardBtn = screen.getByTitle("Board view");
      const listBtn = screen.getByTitle("List view");
      expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
      expect(listBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("renders view overflow trigger when todos are enabled", () => {
      renderHeader({ onChangeView: noop, todosEnabled: true });
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });


    it("does not render the retired Stash Recovery view overflow item", () => {
      renderHeader({ onChangeView: noop, todosEnabled: true, stashOrphanCount: 4 });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-stash-recovery")).toBeNull();
    });

    it.each(["desktop", "tablet"] as const)("keeps More views as a chevron dropdown instead of a right-dock toggle on %s", (tier) => {
      renderHeader({ onChangeView: noop, todosEnabled: true }, tier);

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-chevron-down")).toBeTruthy();
      expect(trigger.querySelector(".lucide-panel-right")).toBeNull();
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      expect(trigger).not.toHaveAttribute("aria-pressed");
      fireEvent.click(trigger);
      expect(screen.getByRole("menu", { name: "More views" })).toBeInTheDocument();
    });

    it.each(["desktop", "tablet"] as const)("renders no duplicate Header right-dock toggle when left sidebar hides view nav on %s", (tier) => {
      renderHeader({
        onChangeView: noop,
        leftSidebarNavActive: true,
        todosEnabled: true,
      }, tier);

      expect(screen.queryByTestId("view-toggle-overflow-trigger")).toBeNull();
      expect(document.querySelector(".header-right-dock-toggle")).toBeNull();
    });

    it("keeps the legacy chevron dropdown on mobile", () => {
      renderHeader({
        onChangeView: noop,
        mobileNavEnabled: false,
      }, "mobile");

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-chevron-down")).toBeTruthy();
      expect(trigger.querySelector(".lucide-panel-right")).toBeNull();
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      fireEvent.click(trigger);
      expect(screen.getByRole("menu", { name: "More views" })).toBeInTheDocument();
    });

    /*
     * FN-426 moved Secrets into Settings → project Secrets, so the header no longer offers it as a destination of its
     * own. The `secrets` id is still recognized by App's routing (old links and persisted views open that Settings
     * section), but the standalone menu entry and its shell must be gone.
     */
    it("no longer offers a standalone Secrets destination in the overflow menu", () => {
      renderHeader({ onChangeView: noop, view: "board" });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-secrets")).toBeNull();
      expect(within(screen.getByRole("menu", { name: "More views" })).queryByText("Secrets")).toBeNull();
    });

    it("renders dependency graph in overflow and uses canonical graph task view", () => {
      const onChangeView = vi.fn();
      renderHeader({
        onChangeView,
        pluginDashboardViews: [
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "graph", label: "Graph", componentPath: "./GraphView", icon: "Map", placement: "more" },
          },
          {
            pluginId: "fusion-plugin-dependency-graph",
            view: { viewId: "queue", label: "Queue", componentPath: "./QueueView", icon: "Workflow" },
          },
        ],
      });

      expect(screen.queryByTestId("view-toggle-plugin-fusion-plugin-dependency-graph-graph")).toBeNull();

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      const graphItem = screen.getByTestId("view-overflow-plugin-fusion-plugin-dependency-graph-graph");
      expect(graphItem.querySelector(".lucide-map")).toBeTruthy();
      fireEvent.click(graphItem);
      expect(onChangeView).toHaveBeenCalledWith("graph");

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      const queueItem = screen.getByTestId("view-overflow-plugin-fusion-plugin-dependency-graph-queue");
      expect(queueItem.querySelector(".lucide-workflow")).toBeTruthy();
      fireEvent.click(queueItem);
      expect(onChangeView).toHaveBeenCalledWith("plugin:fusion-plugin-dependency-graph:queue");
    });

    it("renders hosted roadmaps primary item when roadmap plugin view is present", () => {
      renderHeader({
        onChangeView: noop,
        experimentalFeatures: {},
        pluginDashboardViews: [
          {
            pluginId: "fusion-plugin-roadmap",
            view: { viewId: "roadmaps", label: "Roadmaps", componentPath: "./RoadmapsView", icon: "Map", placement: "primary" },
          },
        ],
      });

      expect(screen.getByTestId("view-toggle-plugin-fusion-plugin-roadmap-roadmaps")).toBeInTheDocument();
    });

    it("shows Compound Engineering in sidebar-off header navigation and removes it after disable and uninstall", () => {
      const compoundEngineeringView = [{
        pluginId: "fusion-plugin-compound-engineering",
        view: {
          viewId: "compound-engineering",
          label: "Compound Engineering",
          componentPath: "./CompoundEngineeringView",
          icon: "Boxes",
          placement: "primary" as const,
          order: 36,
        },
      }];
      const rendered = renderHeader({
        onChangeView: noop,
        leftSidebarNavActive: false,
        pluginDashboardViews: compoundEngineeringView,
      });
      const testId = "view-toggle-plugin-fusion-plugin-compound-engineering-compound-engineering";

      expect(screen.getByTestId(testId)).toBeInTheDocument();
      rendered.rerender(<Header onOpenSettings={noop} onOpenGitHubImport={noop} onChangeView={noop} leftSidebarNavActive={false} pluginDashboardViews={[]} />);
      expect(screen.queryByTestId(testId)).toBeNull();

      rendered.rerender(<Header onOpenSettings={noop} onOpenGitHubImport={noop} onChangeView={noop} leftSidebarNavActive={false} pluginDashboardViews={compoundEngineeringView} />);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      rendered.rerender(<Header onOpenSettings={noop} onOpenGitHubImport={noop} onChangeView={noop} leftSidebarNavActive={false} pluginDashboardViews={[]} />);
      expect(screen.queryByTestId(testId)).toBeNull();
    });

    it("renders view overflow trigger when an experimental overflow feature is enabled", () => {
      renderHeader({ onChangeView: noop, experimentalFeatures: { insights: true } });
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });

    it("omits standalone Artifacts and Recommendations destinations on desktop and tablet", () => {
      const desktop = renderHeader({ onChangeView: noop, showAgentsTab: true }, "desktop");
      expect(screen.queryByTestId("view-toggle-documents")).toBeNull();
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-documents")).toBeNull();
      expect(screen.queryByTestId("view-overflow-recommendations")).toBeNull();
      desktop.unmount();

      renderHeader({ onChangeView: noop, showAgentsTab: true }, "tablet");
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-documents")).toBeNull();
      expect(screen.queryByTestId("view-overflow-recommendations")).toBeNull();
    });

    it("renders view overflow trigger when skills tab is enabled", () => {
      renderHeader({ onChangeView: noop, showSkillsTab: true });
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
    });

    it("does not render research in overflow when researchView is disabled", () => {
      renderHeader({
        onChangeView: noop,
        showSkillsTab: false,
        experimentalFeatures: { insights: false, memoryView: false, devServerView: false, researchView: false },
      });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-research")).toBeNull();
    });

    it("routes to research from the desktop view overflow when enabled", () => {
      const onChangeView = vi.fn();
      renderHeader({
        onChangeView,
        experimentalFeatures: { researchView: true },
      });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-research"));

      expect(onChangeView).toHaveBeenCalledWith("research");
      expect(screen.queryByTestId("view-overflow-research")).toBeNull();
    });

    it("gates Ideation in the desktop overflow and routes the enabled fallback", () => {
      const hidden = renderHeader({ onChangeView: noop, experimentalFeatures: { ideationView: false } });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-ideation")).toBeNull();
      hidden.unmount();

      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "ideation", experimentalFeatures: { ideationView: true } });
      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger).toHaveClass("active");
      fireEvent.click(trigger);
      fireEvent.click(screen.getByTestId("view-overflow-ideation"));
      expect(onChangeView).toHaveBeenCalledWith("ideation");
    });

    it("hides evals in the desktop view overflow when evalsView is disabled", () => {
      renderHeader({ onChangeView: noop, experimentalFeatures: { evalsView: false } });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-evals")).toBeNull();
    });

    it("routes to evals from the desktop view overflow when evalsView is enabled", () => {
      const onChangeView = vi.fn();
      renderHeader({ onChangeView, experimentalFeatures: { evalsView: true } });

      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      fireEvent.click(screen.getByTestId("view-overflow-evals"));

      expect(onChangeView).toHaveBeenCalledWith("evals");
      expect(screen.queryByTestId("view-overflow-evals")).toBeNull();
    });

    it("gates goals overflow entry and routes to goalsView when enabled", () => {
      const hidden = renderHeader({ onChangeView: noop, experimentalFeatures: { goalsView: false, insights: true } });
      fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
      expect(screen.queryByTestId("view-overflow-goals")).toBeNull();
      hidden.unmount();

      const onChangeView = vi.fn();
      renderHeader({ onChangeView, view: "goalsView", experimentalFeatures: { goalsView: true } });

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.className).toContain("active");
      fireEvent.click(trigger);

      const goalsItem = screen.getByTestId("view-overflow-goals");
      expect(goalsItem.className).toContain("active");
      fireEvent.click(goalsItem);

      expect(onChangeView).toHaveBeenCalledWith("goalsView");
      expect(screen.queryByTestId("view-overflow-goals")).toBeNull();
    });
  });

  describe("terminal launcher relocation", () => {
    it("does not render the terminal launcher or scripts chevron in the desktop header", () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "desktop");
      expect(screen.queryByTitle("Open Terminal")).toBeNull();
      expect(screen.queryByTestId("terminal-toggle-btn")).toBeNull();
      expect(screen.queryByTestId("scripts-btn")).toBeNull();
      expect(screen.queryByTestId("terminal-split-btn")).toBeNull();
    });

    it("does not render terminal launcher affordances in the mobile header overflow", () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTitle("Open Terminal")).toBeNull();
      expect(screen.queryByTestId("terminal-toggle-btn")).toBeNull();
      expect(screen.queryByTestId("scripts-btn")).toBeNull();
      expect(screen.queryByTestId("terminal-split-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-primary-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-submenu-toggle")).toBeNull();
    });
  });

  describe("files button", () => {
    it("does not render files button on desktop when handler is provided", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
      expect(screen.queryByTestId("files-toggle-btn")).toBeNull();
    });

    it("does not render files button on desktop when handler is omitted", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
    });

    it("does not call onOpenFiles from the removed desktop files button", () => {
      const onOpenFiles = vi.fn();
      renderHeader({ onOpenFiles }, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
      expect(onOpenFiles).not.toHaveBeenCalled();
    });

    it("does not render an active files shell when files modal is open on desktop", () => {
      renderHeader({ onOpenFiles: vi.fn(), filesOpen: true }, "desktop");
      expect(screen.queryByTitle("Browse files")).toBeNull();
    });

    it("shows files action in mobile overflow menu", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-files-btn")).toBeDefined();
    });

    it("calls onOpenFiles from mobile overflow menu", () => {
      const onOpenFiles = vi.fn();
      renderHeader({ onOpenFiles }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-files-btn"));
      expect(onOpenFiles).toHaveBeenCalled();
    });
  });


  describe("pause controls", () => {
    it("does not render the retired header engine control affordance", () => {
      renderHeader();
      expect(screen.queryByTestId("engine-control-main-btn")).toBeNull();
      expect(screen.queryByTestId("engine-control-chevron-btn")).toBeNull();
      expect(screen.queryByTestId("engine-control-pause-triage-btn")).toBeNull();
    });
  });

  describe("usage button", () => {
    it("does not render usage button when onOpenUsage is not provided", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("View usage")).toBeNull();
    });

    it("does not render usage button when onOpenUsage is not provided on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.queryByTitle("View usage")).toBeNull();
    });

    it("renders the header usage button to the left of the right-dock toggle on desktop when onOpenUsage is provided", () => {
      renderHeader({ onOpenUsage: vi.fn(), rightDockAvailable: true, onToggleRightDock: noop }, "desktop");
      const usageBtn = screen.getByTestId("header-usage-btn");
      expect(usageBtn.getAttribute("title")).toBe("View usage");
      // Retired legacy toolbar testid stays gone.
      expect(screen.queryByTestId("desktop-header-usage-btn")).toBeNull();
      // Sits immediately to the left of the right-dock toggle.
      expect(usageBtn.nextElementSibling).toBe(screen.getByTestId("header-right-dock-toggle"));
    });

    it("fires onOpenUsage with button bounds from the desktop header usage button", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "desktop");
      const usageBtn = screen.getByTestId("header-usage-btn") as HTMLButtonElement;
      const mockRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      usageBtn.getBoundingClientRect = vi.fn(() => mockRect);
      fireEvent.click(usageBtn);
      expect(onOpenUsage).toHaveBeenCalledWith(mockRect);
    });

    it("keeps usage in the legacy mobile overflow when bottom navigation is inactive", () => {
      renderHeader({ onOpenUsage: vi.fn() }, "mobile");
      expect(screen.queryByTestId("mobile-header-usage-btn")).toBeNull();
      expect(screen.queryByTitle("View usage")).toBeNull();
      expect(screen.queryByTestId("desktop-header-usage-btn")).toBeNull();
    });

    it("shows usage in overflow menu on mobile", () => {
      renderHeader({ onOpenUsage: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-usage-btn")).toBeDefined();
    });

    it("opens Usage with button bounds from the official mobile header shortcut", () => {
      const onOpenUsage = vi.fn();
      renderHeader({
        mobileNavEnabled: true,
        onOpenUsage,
      }, "mobile");

      const usageButton = screen.getByTestId("mobile-header-usage-btn") as HTMLButtonElement;
      const mockRect = {
        top: 10,
        bottom: 42,
        left: 200,
        right: 232,
        width: 32,
        height: 32,
        x: 200,
        y: 10,
        toJSON: () => ({}),
      } as DOMRect;
      usageButton.getBoundingClientRect = vi.fn(() => mockRect);

      expect(usageButton).toHaveAccessibleName("View usage");
      fireEvent.click(usageButton);
      expect(onOpenUsage).toHaveBeenCalledWith(mockRect);
      expect(screen.queryByTestId("mobile-menu-trigger")).toBeNull();
    });

    it("does not call onOpenUsage from the removed desktop toolbar button", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "desktop");
      expect(screen.queryByTestId("desktop-header-usage-btn")).toBeNull();
      expect(onOpenUsage).not.toHaveBeenCalled();
    });

    it("calls onOpenUsage with button bounds when usage button in overflow menu is clicked", () => {
      const onOpenUsage = vi.fn();
      renderHeader({ onOpenUsage }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      const usageButton = screen.getByTestId("overflow-usage-btn") as HTMLButtonElement;
      const mockRect = {
        top: 100,
        bottom: 132,
        left: 20,
        right: 180,
        width: 160,
        height: 32,
        x: 20,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect;
      usageButton.getBoundingClientRect = vi.fn(() => mockRect);

      fireEvent.click(usageButton);
      expect(onOpenUsage).toHaveBeenCalledWith(mockRect);
    });
  });

  describe("activity log button", () => {
    it("does not render activity log button when onOpenActivityLog is not provided", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
    });

    it("does not render activity log button when onOpenActivityLog is not provided on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
    });

    it("does not render activity log button inline on desktop when onOpenActivityLog is provided", () => {
      renderHeader({ onOpenActivityLog: vi.fn() }, "desktop");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
    });

    it("does not render activity log button inline on mobile when onOpenActivityLog is provided", () => {
      renderHeader({ onOpenActivityLog: vi.fn() }, "mobile");
      // Button should NOT be inline on mobile (it's in overflow menu)
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
    });

    it("shows activity log in overflow menu on mobile", () => {
      renderHeader({ onOpenActivityLog: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByTestId("overflow-activity-log-btn")).toBeDefined();
    });

    it("does not call onOpenActivityLog from the removed desktop toolbar button", () => {
      const onOpenActivityLog = vi.fn();
      renderHeader({ onOpenActivityLog }, "desktop");
      expect(screen.queryByTitle("View Activity Log")).toBeNull();
      expect(onOpenActivityLog).not.toHaveBeenCalled();
    });

    it("calls onOpenActivityLog when activity log button in overflow menu is clicked", () => {
      const onOpenActivityLog = vi.fn();
      renderHeader({ onOpenActivityLog }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-activity-log-btn"));
      expect(onOpenActivityLog).toHaveBeenCalled();
    });
  });

  describe("planning button", () => {
    it("does not render legacy planning affordances in the header on desktop", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
      expect(screen.queryByTitle("Resume planning session")).toBeNull();
      expect(screen.queryByTestId("planning-btn")).toBeNull();
      expect(screen.queryByTestId("planning-badge")).toBeNull();
    });

    it("does not render legacy planning affordances in the header on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.queryByTitle("Create a task with AI planning")).toBeNull();
      expect(screen.queryByTestId("overflow-planning-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-planning-badge")).toBeNull();
    });
  });

  describe("mobile overflow menu", () => {
    it("renders overflow trigger on mobile", () => {
      renderHeader({}, "mobile");
      expect(screen.getByTitle("More header actions")).toBeDefined();
    });

    it("does not render overflow trigger on desktop", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTitle("More header actions")).toBeNull();
    });

    it("does not render terminal or scripts affordances in mobile header overflow", () => {
      renderHeader({ onToggleTerminal: noop, onOpenScripts: noop, onRunScript: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-terminal-primary-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-submenu-toggle")).toBeNull();
      expect(screen.queryByTestId("overflow-scripts-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-terminal-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-scripts-manage")).toBeNull();
    });

    it("shows GitHub import in overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Import from GitHub")).toBeDefined();
    });

    it("keeps Mailbox in the compact overflow with unread and approval badges", () => {
      const onOpenMailbox = vi.fn();
      renderHeader({ onOpenMailbox, mailboxUnreadCount: 3, mailboxPendingApprovalCount: 2 }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      const mailboxButton = screen.getByTestId("overflow-mailbox-btn");
      expect(mailboxButton).toHaveTextContent("Mailbox (3)");
      expect(screen.getByTestId("overflow-mailbox-approval-badge")).toHaveTextContent("2");

      fireEvent.click(mailboxButton);
      expect(onOpenMailbox).toHaveBeenCalledTimes(1);
    });

    it("keeps compact overflow tool ordering from before terminal moved to the footer launcher", () => {
      renderHeader({ onOpenGitManager: noop, onOpenSchedules: noop, onOpenActivityLog: noop, onOpenMailbox: noop, onOpenUsage: noop, onOpenWorkflowEditor: noop }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      const menu = screen.getByRole("menu", { name: "Additional header actions" });
      const orderedItems = [
        "overflow-git-btn",
        "overflow-schedules-btn",
        "overflow-activity-log-btn",
        "overflow-mailbox-btn",
        "overflow-usage-btn",
        "overflow-workflow-steps-btn",
      ].map((testId) => screen.getByTestId(testId));

      expect(menu).toContainElement(orderedItems[0]);
      for (let index = 1; index < orderedItems.length; index += 1) {
        expect(orderedItems[index - 1].compareDocumentPosition(orderedItems[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it("omits planning from the header overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-planning-btn")).toBeNull();
      expect(screen.queryByTestId("overflow-planning-badge")).toBeNull();
      expect(screen.queryByText("Create a task with AI planning")).toBeNull();
      expect(screen.queryByText("Resume planning session (1)")).toBeNull();
    });

    it("shows settings in overflow menu on mobile", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Settings")).toBeDefined();
    });
  });

  describe("nodes button", () => {
    it("omits the empty desktop overflow trigger after Nodes and Automation moved elsewhere", () => {
      renderHeader({}, "desktop");
      expect(screen.queryByTestId("desktop-overflow-trigger")).toBeNull();
      expect(screen.queryByTestId("desktop-overflow-nodes-btn")).toBeNull();
    });

    it("omits Nodes action from mobile overflow menu because Nodes lives in Command Center", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.queryByTestId("overflow-nodes-btn")).toBeNull();
    });
  });

  describe("non-mobile search toggle", () => {
    it("does not render search toggle when onSearchChange is not provided", () => {
      renderHeader({ view: "board" });
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("renders search toggle button when onSearchChange and view='board' are provided", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    });

    it("renders search toggle button when onSearchChange and view='list' are provided", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "list" });
      expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
    });

    it("renders the desktop search toggle after the empty workflow portal slot", () => {
      renderHeader({ onSearchChange: vi.fn(), onChangeView: noop, view: "board", leftSidebarNavActive: true }, "desktop");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      const searchToggle = screen.getByTestId("desktop-inline-header-search-btn");

      expect(screen.getAllByTestId("desktop-inline-header-search-btn")).toHaveLength(1);
      expect(workflowSlot.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the desktop search toggle after a populated workflow portal slot", () => {
      renderHeader({ onSearchChange: vi.fn(), onChangeView: noop, view: "board", leftSidebarNavActive: true }, "desktop");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      const workflowSwitcher = document.createElement("button");
      workflowSwitcher.type = "button";
      workflowSwitcher.dataset.testid = "mock-workflow-switcher";
      workflowSwitcher.textContent = "Coding workflow";
      workflowSlot.appendChild(workflowSwitcher);
      const searchToggle = screen.getByTestId("desktop-inline-header-search-btn");

      expect(screen.getAllByTestId("desktop-inline-header-search-btn")).toHaveLength(1);
      expect(workflowSlot.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(workflowSwitcher.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the tablet search toggle after the workflow portal slot", () => {
      renderHeader({ onSearchChange: vi.fn(), onChangeView: noop, view: "board", leftSidebarNavActive: true }, "tablet");
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      const searchToggle = screen.getByTestId("desktop-header-search-btn");

      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
      expect(workflowSlot.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("does not render search toggle when view is 'agents'", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "agents" });
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("does not render search toggle when view is 'missions'", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "missions" });
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("does not render search input by default when toggle is visible", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
    });

    it("opens search input when toggle button is clicked", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    });

    it("closes search when Escape is pressed in the field", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      fireEvent.keyDown(screen.getByPlaceholderText("Search tasks..."), { key: "Escape" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
    });

    it("clears search query when Escape is pressed in the field", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      fireEvent.keyDown(screen.getByPlaceholderText("Search tasks..."), { key: "Escape" });
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("restores the board search open button after Escape on a populated query and parent clear", () => {
      const onSearchChange = vi.fn();
      const { rerender } = renderHeader({ onSearchChange, view: "board", searchQuery: "blocked" });

      expect(screen.getByDisplayValue("blocked")).toBeInTheDocument();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();

      fireEvent.keyDown(screen.getByDisplayValue("blocked"), { key: "Escape" });
      expect(onSearchChange).toHaveBeenCalledWith("");
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();

      mockMatchMedia("desktop");
      rerender(
        <Header
          onOpenSettings={noop}
          onOpenGitHubImport={noop}
          onSearchChange={onSearchChange}
          view="board"
          searchQuery=""
        />
      );

      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
      expect(screen.getAllByRole("button", { name: "Open search" })).toHaveLength(1);
      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
    });

    it("keeps search open when searchQuery is non-empty", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board", searchQuery: "test" });
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("shows search input with active query and hides toggle", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "list", searchQuery: "test" });
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.getByDisplayValue("test")).toBeDefined();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
    });

    it("calls onSearchChange when typing in search input", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      const input = screen.getByPlaceholderText("Search tasks...");
      fireEvent.change(input, { target: { value: "test query" } });
      expect(onSearchChange).toHaveBeenCalledWith("test query");
    });

    it("search input has correct placeholder text", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      const input = screen.getByPlaceholderText("Search tasks...");
      expect(input).toBeDefined();
    });

    it("renders search input inside header-floating-search on desktop board view", () => {
      const { container } = renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(container.querySelector(".header-floating-search .header-search")).not.toBeNull();
    });

    it("does not render search input inside header-actions", () => {
      const { container } = renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(container.querySelector(".header-actions .header-search")).toBeNull();
    });

    it("renders header-wrapper containing both header and floating search", () => {
      const { container } = renderHeader({ onSearchChange: vi.fn(), view: "board" });
      const wrapper = container.querySelector(".header-wrapper");
      expect(wrapper).not.toBeNull();
      expect(wrapper!.querySelector("header.header")).not.toBeNull();
    });

    it("hides the open toggle while search is open and restores it after Escape", () => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" });
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
      fireEvent.keyDown(screen.getByPlaceholderText("Search tasks..."), { key: "Escape" });
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
      expect(screen.getAllByTestId("desktop-header-search-btn")).toHaveLength(1);
    });

    it("supports search toggle flow on list view", () => {
      const onSearchChange = vi.fn();
      renderHeader({ onSearchChange, view: "list" });
      // Toggle visible on list view
      expect(screen.getByTestId("desktop-header-search-btn")).toBeDefined();
      // Click toggle
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      // Search opens
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      // Close and clear via Escape
      fireEvent.keyDown(screen.getByPlaceholderText("Search tasks..."), { key: "Escape" });
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it.each(["desktop", "tablet", "mobile"] as const)("does not render removed branch filters on %s", (mode) => {
      renderHeader({ onSearchChange: vi.fn(), view: "board" }, mode);
      if (mode === "mobile") fireEvent.click(screen.getByTestId("mobile-header-search-btn"));
      else if (mode === "tablet") fireEvent.click(screen.getByTestId("desktop-header-search-btn"));

      expect(screen.queryByText("Working branch")).toBeNull();
      expect(screen.queryByText("Base branch")).toBeNull();
      expect(screen.queryByTestId("header-branch-filters-desktop")).toBeNull();
      expect(screen.queryByTestId("header-branch-filters-mobile")).toBeNull();
    });

    it("rend le champ Alpha desktop inline sans panneau flottant", () => {
      const { container } = renderHeader({ onSearchChange: vi.fn(), view: "board" }, "desktop");
      fireEvent.click(screen.getByTestId("desktop-inline-header-search-btn"));
      expect(container.querySelector(".header-actions .header-search--inline")).toBeInTheDocument();
      expect(container.querySelector(".header-floating-search")).toBeNull();
      expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    });

    it.each([
      { tier: "tablet" as const, triggerTestId: "desktop-header-search-btn" },
      { tier: "mobile" as const, triggerTestId: "mobile-header-search-btn" },
    ])("preserves the Alpha $tier floating search", ({ tier, triggerTestId }) => {
      const onSearchChange = vi.fn();
      const { container } = renderHeader({ onSearchChange, view: "board" }, tier);

      expect(screen.getByTestId(triggerTestId)).toBeInTheDocument();
      expect(screen.queryByTestId("desktop-inline-header-search-btn")).toBeNull();
      fireEvent.click(screen.getByTestId(triggerTestId));

      const floatingSearch = container.querySelector(".header-floating-search");
      expect(floatingSearch).toBeInTheDocument();
      expect(floatingSearch?.querySelector('[role="combobox"]')).toBeInTheDocument();
      expect(container.querySelector(".header-actions .header-search--inline")).toBeNull();
      expect(screen.queryByTestId("alpha-task-search-overlay")).toBeNull();
      expect(document.querySelector('[aria-modal="true"]')).toBeNull();

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "alpha query" } });
      expect(onSearchChange).toHaveBeenCalledWith("alpha query");
    });

    /*
    FNXC:TaskSearch 2026-09-17-07:43:
    FN-494 remplace le cas « applique l'id sélectionné au filtre ». Ce contrat est supprimé : les deux
    champs flottants ne fournissaient aucun `onSelectTask`, donc une sélection écrivait l'identifiant
    dans le filtre Board/List et n'ouvrait jamais la fiche. La règle est désormais identique aux trois
    hôtes : vider le champ, fermer la recherche, ouvrir la fiche.
    */
    it.each(["tablet", "mobile"] as const)("(c2)/(c3) la sélection vide le champ, ferme la recherche et ouvre la fiche sur %s", async (tier) => {
      mockFetchTaskPage.mockResolvedValue(searchPage([
        { id: "FN-352", title: "Dans la barre de recherche" },
      ]) as never);
      const onQueryChange = vi.fn();
      const onSelectSearchTask = vi.fn();
      renderSearchHeader(tier, { onQueryChange, onSelectSearchTask });
      if (tier === "tablet") fireEvent.click(screen.getByTestId("desktop-header-search-btn"));
      if (tier === "mobile") fireEvent.click(screen.getByTestId("mobile-header-search-btn"));

      const input = screen.getByRole("combobox");
      fireEvent.change(input, { target: { value: "52" } });

      await waitFor(() => expect(screen.getByText("FN-352")).toBeInTheDocument());
      expect(screen.queryByRole("listbox")).toBeNull();

      fireEvent.click(screen.getByText("FN-352"));

      expect(onSelectSearchTask).toHaveBeenCalledTimes(1);
      expect(onSelectSearchTask.mock.calls[0][0].id).toBe("FN-352");
      expect(onQueryChange).toHaveBeenCalledWith("");
      expect(onQueryChange).not.toHaveBeenCalledWith("FN-352");
      // Ni panneau portalisé, ni champ de recherche encore monté.
      await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
      expect(document.querySelector(".task-search-results")).toBeNull();
    });

    it("transmet la requête au serveur plutôt que de filtrer une collection chargée", async () => {
      mockFetchTaskPage.mockResolvedValue(searchPage([{ id: "FN-902", title: "Add the bonjour.txt file" }]) as never);
      renderSearchHeader("tablet");
      fireEvent.click(screen.getByTestId("desktop-header-search-btn"));

      fireEvent.change(screen.getByRole("combobox"), { target: { value: ".txt" } });

      // Suffixes and literal punctuation reach the shared server predicate untouched.
      await waitFor(() => expect(mockFetchTaskPage).toHaveBeenCalledWith(
        "project-a",
        expect.objectContaining({ query: ".txt" }),
      ));
    });
  });

  describe("automation button", () => {
    it("does not render automation in a desktop overflow shell", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      expect(screen.queryByTestId("desktop-overflow-trigger")).toBeNull();
      expect(screen.queryByTestId("desktop-overflow-schedules-btn")).toBeNull();
    });

    it("does not render automation button inline on mobile", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "mobile");
      expect(screen.queryByTitle("Automation")).toBeNull();
    });

    it("does not call onOpenSchedules from the removed desktop overflow", () => {
      const onOpenSchedules = vi.fn();
      renderHeader({ onOpenSchedules }, "desktop");
      expect(screen.queryByTestId("desktop-overflow-schedules-btn")).toBeNull();
      expect(onOpenSchedules).not.toHaveBeenCalled();
    });

    it("removes the desktop automation data-testid with the empty overflow trigger", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "desktop");
      expect(screen.queryByTestId("desktop-overflow-schedules-btn")).toBeNull();
    });

    it("includes automation in overflow menu on mobile", () => {
      renderHeader({ onOpenSchedules: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByText("Automation")).toBeDefined();
    });

    it("calls onOpenSchedules from mobile overflow menu", () => {
      const onOpenSchedules = vi.fn();
      renderHeader({ onOpenSchedules }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      fireEvent.click(screen.getByTestId("overflow-schedules-btn"));
      expect(onOpenSchedules).toHaveBeenCalled();
    });
  });

  describe("mobile header layout", () => {
    it("applies header-project-selector class when multiple projects exist on mobile", () => {
      const { container } = renderHeader({
        projects: [
          { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
          { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
        ],
        currentProject: { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      }, "mobile");
      expect(container.querySelector(".header-project-selector")).toBeDefined();
    });

    it("does not show project selector on mobile with single project", () => {
      const { container } = renderHeader({
        projects: [{ id: "1", name: "Project One", path: "/path/one", status: "active" as const }],
      }, "mobile");
      expect(container.querySelector(".header-project-selector")).toBeNull();
    });

    it("renders header-back-button when currentProject is set on mobile", () => {
      const { container } = renderHeader({
        currentProject: { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        onViewAllProjects: vi.fn(),
      }, "mobile");
      expect(container.querySelector(".header-back-button")).toBeDefined();
    });

    it("does not render header-back-button on mobile when no currentProject", () => {
      const { container } = renderHeader({}, "mobile");
      expect(container.querySelector(".header-back-button")).toBeNull();
    });

    it("mobile overflow menu closes when clicking outside", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByRole("menu")).toBeDefined();

      // Click outside the menu
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("mobile overflow menu closes on Escape key", () => {
      renderHeader({ onOpenFiles: vi.fn() }, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));
      expect(screen.getByRole("menu")).toBeDefined();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("mobile overflow trigger has correct accessibility attributes", () => {
      renderHeader({}, "mobile");
      const trigger = screen.getByTitle("More header actions");
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    it("hides logo-sub on mobile via CSS", () => {
      renderHeader({}, "mobile");
      // The "tasks" element no longer exists - it was removed
    });
  });

  describe("mobile search with mobileNavEnabled", () => {
    it("renders mobile search input when searchQuery is active with mobileNavEnabled", () => {
      renderHeader({ view: "board", searchQuery: "test query", onSearchChange: vi.fn(), onChangeView: noop }, "mobile");
      // Search should be visible even with mobileNavEnabled when query is active
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
      expect(screen.getByDisplayValue("test query")).toBeDefined();
    });

    it("can open mobile search when mobileNavEnabled is true", () => {
      renderHeader({ view: "board", searchQuery: "", onSearchChange: vi.fn(), onChangeView: noop, mobileNavEnabled: true }, "mobile");
      // Should show the trigger button
      const mobileSearchTrigger = screen.getByTestId("mobile-header-search-btn");
      expect(mobileSearchTrigger).toBeDefined();
      expect(screen.getByTestId("header-workflow-slot")).toBeInTheDocument();
      expect(screen.queryByTestId("desktop-header-search-btn")).toBeNull();
      // Expanded search should not be visible initially, then opens from the unchanged mobile trigger.
      expect(screen.queryByPlaceholderText("Search tasks...")).toBeNull();
      fireEvent.click(mobileSearchTrigger);
      expect(screen.getByPlaceholderText("Search tasks...")).toBeDefined();
    });

    it("closes mobile search and clears query when Escape is pressed with mobileNavEnabled", () => {
      const onSearchChange = vi.fn();
      renderHeader({ view: "board", searchQuery: "test query", onSearchChange, onChangeView: noop }, "mobile");
      fireEvent.keyDown(screen.getByDisplayValue("test query"), { key: "Escape" });
      expect(onSearchChange).toHaveBeenCalledWith("");
    });

    it("does not render mobile project switch trigger on desktop", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "desktop");
      expect(screen.queryByTestId("mobile-project-switch-trigger")).toBeNull();
    });

    it("does not render mobile project switch trigger on tablet", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "tablet");
      expect(screen.queryByTestId("mobile-project-switch-trigger")).toBeNull();
    });

    it("renders mobile project switch trigger on mobile with 2+ projects", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");
      expect(screen.getByTestId("mobile-project-switch-trigger")).toBeDefined();
    });

    it("renders mobile project switch trigger on mobile with single project", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");
      expect(screen.getByTestId("mobile-project-switch-trigger")).toBeDefined();
    });

    it("closes compact project switch dropdown on Escape in mobile mode", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "paused" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("closes compact project switch dropdown on outside click in mobile mode", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "paused" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-dropdown")).toBeDefined();

      fireEvent.mouseDown(document.body);

      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("closes compact project switch dropdown after selecting a project in mobile mode", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
        { id: "2", name: "Project Two", path: "/path/two", status: "paused" as const },
      ];
      const onSelectProject = vi.fn();
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject,
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      fireEvent.click(screen.getByTestId("mobile-project-switch-item-2"));

      expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("shows View Projects action in mobile project switch when onViewAllProjects is provided", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
        onViewAllProjects: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.getByTestId("mobile-project-switch-view-all")).toBeInTheDocument();
    });

    it("calls onViewAllProjects and closes dropdown from mobile View Projects action", async () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      const onViewAllProjects = vi.fn();
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
        onViewAllProjects,
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      fireEvent.click(screen.getByTestId("mobile-project-switch-view-all"));

      expect(onViewAllProjects).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.queryByTestId("mobile-project-switch-dropdown")).toBeNull();
      });
    });

    it("hides View Projects action in mobile project switch when onViewAllProjects is not provided", () => {
      const projects = [
        { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
      ];
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: vi.fn(),
      }, "mobile");

      fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
      expect(screen.queryByTestId("mobile-project-switch-view-all")).toBeNull();
    });
  });

  describe("Manage Projects action", () => {
    const projects = [
      { id: "1", name: "Test Project", path: "/path/to/project", status: "active" as const },
      { id: "2", name: "Other Project", path: "/path/to/other", status: "paused" as const },
    ];

    it("renders project selector trigger on desktop with multiple projects", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");
      expect(screen.getByTestId("project-selector-trigger")).toBeDefined();
    });

    it("shows current project name in the desktop project selector trigger", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");

      const trigger = screen.getByTestId("project-selector-trigger");
      expect(trigger).toHaveTextContent("Test Project");
    });

    it("includes the full active project name in the trigger label for truncated labels", () => {
      const longName = "This is a very long project name that should be truncated in the header trigger";
      const projectsWithLongName = [
        { id: "1", name: longName, path: "/path/to/project", status: "active" as const },
        { id: "2", name: "Other Project", path: "/path/to/other", status: "paused" as const },
      ];

      renderHeader({
        projects: projectsWithLongName,
        currentProject: projectsWithLongName[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");

      const trigger = screen.getByTestId("project-selector-trigger");
      expect(trigger).toHaveTextContent(longName);
    });

    it("falls back to 'Projects' label when current project is missing", () => {
      renderHeader({
        projects,
        currentProject: null,
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");

      const trigger = screen.getByTestId("project-selector-trigger");
      expect(trigger).toHaveTextContent("Projects");
    });

    it("shows Manage Projects action in dropdown and calls onViewAllProjects", () => {
      const onViewAllProjects = vi.fn();
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects,
        onSelectProject: noop,
      }, "desktop");

      fireEvent.click(screen.getByTestId("project-selector-trigger"));
      fireEvent.click(screen.getByText("Manage Projects"));
      expect(onViewAllProjects).toHaveBeenCalled();
      expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
    });

    it("does not render separate back button on desktop", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onViewAllProjects: noop,
        onSelectProject: noop,
      }, "desktop");
      expect(screen.queryByTestId("back-to-projects-btn")).toBeNull();
    });

    it("does not render project selector when onViewAllProjects is not provided", () => {
      renderHeader({
        projects,
        currentProject: projects[0],
        onSelectProject: noop,
      }, "desktop");
      expect(screen.queryByTestId("project-selector-trigger")).toBeNull();
    });
  });

  describe("action ordering", () => {
    it("places only the Usage button after Settings on desktop after engine controls moved to the footer", () => {
      /*
      FNXC:Navigation 2026-06-22-12:00:
      Usage moved back to the top header (left of the right-dock toggle), so it now renders after Settings in the inline header actions. Settings is the last inline action ONLY among the primary controls; the trailing Usage button (and the right-dock toggle when available) intentionally follow it.
      */
      const { container } = renderHeader({
        onOpenUsage: noop,
        onOpenActivityLog: noop,
        onOpenWorkflowEditor: noop,
        onOpenFiles: noop,
        onOpenGitManager: noop,
        onOpenScripts: noop,
        onRunScript: noop,
      }, "desktop");

      // Get direct top-level header action buttons; engine controls now live in the footer status bar.
      const headerActions = container.querySelector(".header-actions")!;
      expect(headerActions.querySelector(".engine-control-split-btn")).toBeNull();
      const inlineItems = Array.from(
        headerActions.querySelectorAll<HTMLElement>(":scope > button.btn-icon")
      );

      const settingsIdx = inlineItems.findIndex(
        (el) => el instanceof HTMLButtonElement && el.title === "Settings"
      );

      expect(settingsIdx).toBeGreaterThanOrEqual(0);

      const itemsAfterSettings = inlineItems.slice(settingsIdx + 1);
      // Only the relocated Usage button trails Settings (no right-dock toggle without rightDockAvailable).
      expect(itemsAfterSettings.map((el) => el.getAttribute("data-testid"))).toEqual(["header-usage-btn"]);
    });

    it("Settings is the last item in the mobile overflow menu", () => {
      const { container } = renderHeader({
        onOpenUsage: noop,
        onOpenActivityLog: noop,
        onOpenWorkflowEditor: noop,
        onOpenFiles: noop,
        onOpenGitManager: noop,
      }, "mobile");

      fireEvent.click(screen.getByTitle("More header actions"));

      // Get all menu items inside the overflow menu
      const menu = container.querySelector(".mobile-overflow-menu")!;
      const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>("button.mobile-overflow-item"));

      // The last menu item should be Settings
      const lastItem = menuItems[menuItems.length - 1];
      expect(lastItem.textContent).toBe("Settings");
    });

    it("Settings is the last item in the mobile overflow menu even when optional items are absent", () => {
      renderHeader({}, "mobile");
      fireEvent.click(screen.getByTitle("More header actions"));

      // Get the overflow menu items
      const menu = screen.getByRole("menu");
      const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role='menuitem']"));

      const lastItem = menuItems[menuItems.length - 1];
      expect(lastItem.textContent).toBe("Settings");
    });
  });

  /*
  FNXC:DashboardHeader 2026-07-08-00:00:
  FN-7687 regression: the top header must stay structurally single-line at mobile widths
  regardless of which mobile-only children are mounted (project switch, workflow slot,
  view toggle, search/usage triggers) — the row must never rely on the CSS width media
  query alone to prevent wrapping, since a foldable's layout viewport can lag its
  visualViewport pane during a fold/unfold/refold resize. Assert the computed
  `flex-wrap: nowrap` + shrink/min-width-0 contract across populated and empty data states.
  */
  describe("single-line header layout (FN-7687)", () => {
    const projects = [
      { id: "1", name: "Project One", path: "/path/one", status: "active" as const },
    ];

    function assertSingleLineContract(container: HTMLElement) {
      const header = container.querySelector(".header");
      const headerLeft = container.querySelector(".header-left");
      const headerActions = container.querySelector(".header-actions");
      expect(header).not.toBeNull();
      expect(headerLeft).not.toBeNull();
      expect(headerActions).not.toBeNull();

      const headerStyle = window.getComputedStyle(header!);
      expect(headerStyle.flexWrap).toBe("nowrap");
      expect(headerStyle.display).toBe("flex");

      const leftStyle = window.getComputedStyle(headerLeft!);
      expect(leftStyle.minWidth).toBe("0px");
      expect(leftStyle.flexShrink).toBe("1");

      const actionsStyle = window.getComputedStyle(headerActions!);
      expect(actionsStyle.minWidth).toBe("0px");
      expect(actionsStyle.flexGrow).toBe("0");
    }

    it("enforces the single-line contract on mobile with no project and no workflow slot", () => {
      const { container } = renderHeader({}, "mobile");
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on mobile with a selected project (mobile project switch present)", () => {
      const { container } = renderHeader(
        { projects, currentProject: projects[0], onSelectProject: vi.fn() },
        "mobile",
      );
      expect(screen.getByTestId("mobile-project-switch-trigger")).toBeDefined();
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on mobile with the workflow slot populated", () => {
      const { container } = renderHeader(
        { onChangeView: noop, leftSidebarNavActive: true, mobileNavEnabled: true },
        "mobile",
      );
      const workflowSlot = screen.getByTestId("header-workflow-slot");
      // Simulate the board/list workflow portal rendering content into the slot.
      workflowSlot.innerHTML = '<div class="board-workflow-toolbar"><button class="workflow-switcher-trigger">Coding</button></div>';
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on mobile with search open and mobile nav active", () => {
      const { container } = renderHeader(
        { onSearchChange: vi.fn(), onChangeView: noop, mobileNavEnabled: true },
        "mobile",
      );
      fireEvent.click(screen.getByTestId("mobile-header-search-btn"));
      assertSingleLineContract(container);
    });

    it("enforces the single-line contract on desktop and tablet (non-mobile) as well", () => {
      const desktop = renderHeader({}, "desktop");
      assertSingleLineContract(desktop.container);

      const tablet = renderHeader({}, "tablet");
      assertSingleLineContract(tablet.container);
    });
  });
});
