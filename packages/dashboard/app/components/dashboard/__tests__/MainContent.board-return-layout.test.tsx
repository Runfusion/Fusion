import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KeepAliveView } from "../../KeepAliveView";
import { BoardViewReturnHarness } from "../../../test/boardViewReturnFixture";

/*
FNXC:BoardNavigation 2026-09-18-02:12:
FN-522 — « quand je passe d'une vue comme Planning ou Missions au Board, mon board n'apparaît pas comme je l'ai
laissé, comme s'il était poussé par le header des éléments des autres vues ».

Ces cas montent les VRAIS hôtes du retour — `Header` réel, routage `MainContent` réel, vues conservées réelles,
frère Planning conservé — dans la vraie chaîne `.dashboard-project-stack` → `.dashboard-project-shell` →
`.project-content`, et prouvent ce que jsdom peut réellement établir : le propriétaire DOM du sélecteur, l'identité
React conservée du Board, la position horizontale et les offsets de la coque, plus le fait que la résolution du
portail appartient à la phase de LAYOUT et non à un effet passif.

jsdom ne calcule aucun rectangle : la preuve géométrique (bande parasite de 41 px, hauteur utile réduite, première
frame peinte) appartient à `packages/dashboard/src/__tests__/board-return-browser.test.ts`. Ce fichier ne prétend
pas mesurer des pixels.
*/

const workflow = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "triage", name: "Triage", flags: { intake: true } },
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};
/* FN-407 supprime tout sélecteur avec une seule option : deux workflows sont requis pour que le contrôle existe. */
const secondaryWorkflow = { ...workflow, id: "builtin:research", name: "Research" };

const { setSelectedWorkflowId, persistSelection, workflowState } = vi.hoisted(() => ({
  setSelectedWorkflowId: vi.fn(),
  persistSelection: vi.fn(),
  /* Métadonnées de workflow mutables : `null` puis hydratées, comme une réponse qui arrive après le retour. */
  workflowState: { hydrated: true },
}));

vi.mock("../../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => (workflowState.hydrated
    ? {
      boardWorkflows: { defaultWorkflowId: workflow.id, workflows: [workflow, secondaryWorkflow], taskWorkflowIds: {} },
      workflowMode: true,
      workflowOptions: [workflow, secondaryWorkflow],
      /* Sélection NON par défaut : la navigation seule ne doit ni la changer ni la réécrire. */
      selectedWorkflow: secondaryWorkflow,
      selectedWorkflowId: secondaryWorkflow.id,
      isAllWorkflowsSelected: false,
      setSelectedWorkflowId,
      refreshBoardWorkflows: vi.fn(),
      setBoardWorkflowsState: vi.fn(),
    }
    : {
      boardWorkflows: null,
      workflowMode: false,
      workflowOptions: [],
      selectedWorkflow: null,
      selectedWorkflowId: null,
      isAllWorkflowsSelected: false,
      setSelectedWorkflowId,
      refreshBoardWorkflows: vi.fn(),
      setBoardWorkflowsState: vi.fn(),
    }),
}));

vi.mock("../../../hooks/useUnmappedWorkflowRefetch", () => ({ useUnmappedWorkflowRefetch: vi.fn() }));
vi.mock("../../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../ErrorBoundary", () => ({
  PageErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../MissionManager", () => ({
  /*
  Missions est rendu par son vrai hôte de route (`MainContent` + `HeaderWorkflowSwitcherSlot`, non remplacés) ; seul
  son corps métier est réduit à un en-tête de destination, car ce qui est en jeu ici est la LIBÉRATION du slot et de
  la place par la vue quittée, pas le contenu des missions.
  */
  MissionManager: () => (
    <div className="mission-manager" data-testid="mission-manager">
      <header className="view-header">Missions</header>
    </div>
  ),
}));
vi.mock("../../../api", () => ({
  fetchMission: vi.fn(),
  fetchMissions: vi.fn().mockResolvedValue([]),
  fetchInsights: vi.fn().mockResolvedValue({ insights: [] }),
  fetchTaskDetail: vi.fn(),
  listEvals: vi.fn().mockResolvedValue({ results: [] }),
  fetchScripts: vi.fn().mockResolvedValue([]),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchTasks: vi.fn().mockResolvedValue([]),
  fetchNodes: vi.fn().mockResolvedValue([]),
  setProjectBoardSelectedWorkflow: persistSelection,
  fetchPluginUiSlots: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ effective: {} }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  updateTask: vi.fn(),
  refreshPrStatus: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
}));

/** Le contrôle réel, où qu'il vive : un seul doit exister à tout instant. */
function toolbars(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".board-workflow-toolbar"));
}

function headerSlot(): HTMLElement | null {
  return document.getElementById("header-workflow-slot");
}

function toolbarOwner(): "header" | "inline" | "absent" {
  const toolbar = toolbars()[0];
  if (!toolbar) return "absent";
  const slot = headerSlot();
  return slot?.contains(toolbar) ? "header" : "inline";
}

function boardRoot(): HTMLElement {
  const board = document.getElementById("board");
  if (!board) throw new Error("Le vrai Board n'est pas rendu");
  return board;
}

function boardWrapper(): HTMLElement {
  const wrapper = screen.getByTestId("board-keep-alive");
  return wrapper;
}

function navigate(view: "board" | "planning" | "missions" | "list") {
  fireEvent.click(screen.getByTestId(`board-return-nav-${view}`));
}

/** Vue conservée Planning minimale mais utilisant le VRAI primitif partagé de conservation. */
function planningSibling(active: boolean) {
  return (
    <KeepAliveView hidden={!active} testId="planning-keep-alive">
      <div className="planning-view">
        <header className="view-header">Planning</header>
        <textarea data-testid="planning-draft" defaultValue="" />
      </div>
    </KeepAliveView>
  );
}

/** jsdom n'a pas de vraie requête média : `useViewportMode` doit être piloté explicitement. */
function mockViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && query.includes("max-width: 768px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  setSelectedWorkflowId.mockClear();
  persistSelection.mockClear();
  workflowState.hydrated = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  /*
  Restaurer LES DEUX : une `matchMedia` factice laissée en place rendrait les montages suivants indéfinis ou
  bloqués en disposition téléphone.
  */
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: originalMatchMedia });
});

describe("FN-522 retour au tableau depuis Planning et Missions", () => {
  it.each(["planning", "missions"] as const)(
    "conserve l'identité, le contexte horizontal et le propriétaire unique du contrôle après un aller-retour via %s",
    async (destination) => {
      render(<BoardViewReturnHarness planningSibling={planningSibling} />);

      await waitFor(() => expect(headerSlot()).not.toBeNull());
      await waitFor(() => expect(toolbarOwner()).toBe("header"));
      const board = boardRoot();
      const wrapper = boardWrapper();
      const column = board.querySelector<HTMLElement>(".column-body");
      expect(column).not.toBeNull();
      board.scrollLeft = 212;
      const shell = screen.getByTestId("project-content");

      navigate(destination);
      await waitFor(() => expect(wrapper.className).toContain("keep-alive-view--hidden"));
      // La destination libère réellement le slot partagé sur une vraie page large.
      expect(headerSlot()).toBeNull();

      navigate("board");
      await waitFor(() => expect(toolbarOwner()).toBe("header"));

      // Identité React conservée : ni remontage du Board ni nouvelle clé.
      expect(boardRoot()).toBe(board);
      expect(boardWrapper()).toBe(wrapper);
      expect(board.querySelector(".column-body")).toBe(column);
      expect(wrapper.className).not.toContain("keep-alive-view--hidden");
      // Contexte horizontal conservé, aucun scroll parasite de la coque.
      expect(board.scrollLeft).toBe(212);
      expect(shell.scrollTop).toBe(0);
      expect(document.documentElement.scrollTop).toBe(0);
      // Un seul contrôle, dans le bon slot, et aucun reste visible de la vue quittée.
      expect(toolbars()).toHaveLength(1);
      expect(document.querySelectorAll("#header-workflow-slot")).toHaveLength(1);
      expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
      expect(screen.queryByTestId("mission-manager")).toBeNull();
      const planning = screen.getByTestId("planning-keep-alive");
      expect(planning.className).toContain("keep-alive-view--hidden");
      // Naviguer seul n'écrit aucune préférence et ne rechoisit aucun workflow.
      expect(setSelectedWorkflowId).not.toHaveBeenCalled();
      expect(persistSelection).not.toHaveBeenCalled();
    },
  );

  it("traverse Planning puis Missions puis le tableau, deux fois, sans dupliquer le contrôle ni remplacer le Board", async () => {
    render(<BoardViewReturnHarness planningSibling={planningSibling} />);
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    const board = boardRoot();
    board.scrollLeft = 96;

    for (let round = 0; round < 2; round += 1) {
      navigate("planning");
      await waitFor(() => expect(screen.getByTestId("board-keep-alive").className).toContain("keep-alive-view--hidden"));
      navigate("missions");
      await screen.findByTestId("mission-manager");
      navigate("board");
      await waitFor(() => expect(toolbarOwner()).toBe("header"));

      expect(boardRoot(), `identité du Board cycle ${round}`).toBe(board);
      expect(toolbars(), `un seul contrôle cycle ${round}`).toHaveLength(1);
      expect(document.querySelectorAll("#header-workflow-slot"), `un seul slot cycle ${round}`).toHaveLength(1);
      expect(board.scrollLeft, `position horizontale cycle ${round}`).toBe(96);
    }
  });

  it("conserve le brouillon Planning et son nœud à travers le masquage puis la révélation", async () => {
    render(<BoardViewReturnHarness planningSibling={planningSibling} />);
    await waitFor(() => expect(toolbarOwner()).toBe("header"));

    navigate("planning");
    const draft = await screen.findByTestId("planning-draft");
    fireEvent.change(draft, { target: { value: "Brouillon conservé" } });

    navigate("board");
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    navigate("planning");

    expect(screen.getByTestId("planning-draft")).toBe(draft);
    expect(draft).toHaveValue("Brouillon conservé");
  });

  /*
  FNXC:BoardNavigation 2026-09-18-02:12:
  Substitut jsdom exécutable de la propriété « avant peinture ». Un clic discret non enveloppé par `act` est rendu
  de façon synchrone par React : les effets de LAYOUT s'exécutent dans ce commit, tandis que les effets PASSIFS sont
  planifiés dans une tâche ultérieure — exactement la frontière où le navigateur peignait la frame fautive. Observer
  le DOM immédiatement après la répartition de l'événement distingue donc réellement les deux mécanismes : avec une
  résolution passive le contrôle est encore dans son repli en ligne à cet instant, alors qu'une résolution de phase
  layout l'a déjà publié dans le slot du Header.
  */
  it("publie le contrôle dans le slot du Header dès le commit de réactivation, sans attendre les effets passifs", async () => {
    render(<BoardViewReturnHarness planningSibling={planningSibling} />);
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    act(() => {
      navigate("missions");
    });
    await waitFor(() => expect(headerSlot()).toBeNull());

    const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      /*
      Événement DOM direct : ni `act`, ni `flushSync`, qui vident tous deux les effets passifs en attente. React 19
      planifie son travail de voie synchrone dans une MICROTÂCHE, puis ses effets passifs dans une tâche du
      planificateur. Quelques tours de microtâches livrent donc le commit et ses effets de layout, sans laisser
      passer la tâche qui exécuterait un effet passif.
      */
      screen.getByTestId("board-return-nav-board").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
      expect(headerSlot()).not.toBeNull();
      expect(document.querySelector(".board-workflow-view > .board-workflow-toolbar")).toBeNull();
      expect(toolbarOwner()).toBe("header");
      expect(toolbars()).toHaveLength(1);
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    await act(async () => {});
  });

  /*
  FNXC:BoardNavigation 2026-09-18-02:12:
  Ordonnancements adverses du retour : données non encore résolues, réponse répétée après le retour, remplacement
  du slot entre le départ et le retour, et changement de projet. Attendre les données ne doit jamais réinitialiser
  le choix de workflow ni la position horizontale.
  */
  it("revient au tableau avant la résolution des workflows, puis adopte le slot dès l'hydratation", async () => {
    workflowState.hydrated = false;
    const view = render(<BoardViewReturnHarness planningSibling={planningSibling} />);
    await waitFor(() => expect(document.getElementById("board")).not.toBeNull());
    const board = boardRoot();
    const wrapper = boardWrapper();
    board.scrollLeft = 64;

    navigate("planning");
    await waitFor(() => expect(screen.getByTestId("board-keep-alive").className).toContain("keep-alive-view--hidden"));
    navigate("board");
    await waitFor(() => expect(screen.getByTestId("board-keep-alive").className).not.toContain("keep-alive-view--hidden"));

    // Avec des métadonnées absentes, l'absence légitime de contrôle n'est pas un repli égaré.
    expect(toolbars()).toHaveLength(0);
    expect(board.scrollLeft).toBe(64);

    workflowState.hydrated = true;
    act(() => {
      view.rerender(<BoardViewReturnHarness planningSibling={planningSibling} />);
    });
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    expect(toolbars()).toHaveLength(1);
    /*
    Le passage du tableau simple au tableau de workflow remplace légitimement la racine `#board` : c'est le
    wrapper conservé qui porte l'identité de la vue, et c'est lui qui doit survivre.
    */
    expect(boardWrapper()).toBe(wrapper);
    expect(document.querySelectorAll("#header-workflow-slot")).toHaveLength(1);
    expect(setSelectedWorkflowId).not.toHaveBeenCalled();
    expect(persistSelection).not.toHaveBeenCalled();
  });

  it("absorbe une notification de données répétée après le retour sans dupliquer le contrôle", async () => {
    const view = render(<BoardViewReturnHarness planningSibling={planningSibling} />);
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    const board = boardRoot();
    board.scrollLeft = 33;

    navigate("missions");
    await screen.findByTestId("mission-manager");
    navigate("board");
    await waitFor(() => expect(toolbarOwner()).toBe("header"));

    for (let repeat = 0; repeat < 3; repeat += 1) {
      act(() => {
        view.rerender(<BoardViewReturnHarness planningSibling={planningSibling} />);
      });
    }

    expect(toolbars()).toHaveLength(1);
    expect(toolbarOwner()).toBe("header");
    expect(boardRoot()).toBe(board);
    expect(board.scrollLeft).toBe(33);
    expect(persistSelection).not.toHaveBeenCalled();
  });

  it("adopte un slot du Header remplacé entre le départ et le retour", async () => {
    render(<BoardViewReturnHarness planningSibling={planningSibling} />);
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    const firstSlot = headerSlot();

    navigate("missions");
    await waitFor(() => expect(headerSlot()).toBeNull());
    navigate("board");
    await waitFor(() => expect(toolbarOwner()).toBe("header"));

    // Le Header recrée réellement son nœud : la propriété suit le nouveau, jamais l'ancien détaché.
    const secondSlot = headerSlot();
    expect(secondSlot).not.toBe(firstSlot);
    expect(firstSlot?.isConnected).toBe(false);
    expect(document.querySelectorAll("#header-workflow-slot")).toHaveLength(1);
    expect(toolbars()).toHaveLength(1);
  });

  it("remplace l'identité conservée sur un changement de projet, sans laisser deux contrôles", async () => {
    const projectA = { id: "project-a", name: "Projet A" } as never;
    const projectB = { id: "project-b", name: "Projet B" } as never;
    const view = render(
      <BoardViewReturnHarness planningSibling={planningSibling} mainContentOverrides={{ currentProject: projectA }} />,
    );
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    const boardA = boardRoot();

    navigate("planning");
    await waitFor(() => expect(screen.getByTestId("board-keep-alive").className).toContain("keep-alive-view--hidden"));
    act(() => {
      view.rerender(
        <BoardViewReturnHarness planningSibling={planningSibling} mainContentOverrides={{ currentProject: projectB }} />,
      );
    });
    navigate("board");
    await waitFor(() => expect(toolbarOwner()).toBe("header"));

    expect(boardRoot()).not.toBe(boardA);
    expect(boardA.isConnected).toBe(false);
    expect(toolbars()).toHaveLength(1);
    expect(document.querySelectorAll("#header-workflow-slot")).toHaveLength(1);
  });

  /*
  FNXC:BoardNavigation 2026-09-18-02:12:
  Téléphone : Planning/Missions sont hébergés AU-DESSUS d'un Board de fond resté actif (FN-483). Ouvrir puis
  fermer ne doit donc ni désactiver ce Board, ni créer un second propriétaire du slot, ni relancer une arrivée.
  */
  it("garde sur téléphone le même Board de fond actif et un seul propriétaire du slot", async () => {
    mockViewport("mobile");
    render(<BoardViewReturnHarness isMobile planningSibling={planningSibling} />);
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    const board = boardRoot();
    const wrapper = boardWrapper();
    board.scrollLeft = 120;
    const slot = headerSlot();

    for (const destination of ["planning", "missions"] as const) {
      navigate(destination);
      await waitFor(() => expect(screen.getByTestId("board-return-nav-board")).toBeInTheDocument());
      // Le fond reste actif et conserve son unique slot pendant l'ouverture.
      expect(boardWrapper().className).not.toContain("keep-alive-view--hidden");
      expect(headerSlot()).toBe(slot);
      expect(toolbars()).toHaveLength(1);
      expect(toolbarOwner()).toBe("header");

      navigate("board");
      await waitFor(() => expect(toolbarOwner()).toBe("header"));
      expect(boardRoot()).toBe(board);
      expect(boardWrapper()).toBe(wrapper);
      expect(headerSlot()).toBe(slot);
      expect(board.scrollLeft).toBe(120);
      expect(toolbars()).toHaveLength(1);
    }
  });

  it("traverse un changement de largeur pendant que la vue secondaire est ouverte", async () => {
    mockViewport("desktop");
    const view = render(<BoardViewReturnHarness planningSibling={planningSibling} />);
    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    const board = boardRoot();
    board.scrollLeft = 77;

    navigate("missions");
    await screen.findByTestId("mission-manager");

    mockViewport("mobile");
    act(() => {
      window.dispatchEvent(new Event("resize"));
      view.rerender(<BoardViewReturnHarness isMobile planningSibling={planningSibling} />);
    });
    navigate("board");
    await waitFor(() => expect(toolbarOwner()).toBe("header"));

    expect(document.querySelectorAll("#header-workflow-slot")).toHaveLength(1);
    expect(toolbars()).toHaveLength(1);
    // Un vrai redimensionnement garde la position horizontale mesurée, pas un ancien offset recopié.
    expect(board.scrollLeft).toBe(77);
  });

  it("reste stable sous StrictMode, où chaque effet est monté, démonté puis remonté", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <BoardViewReturnHarness planningSibling={planningSibling} />
        </StrictMode>,
      );
    });

    await waitFor(() => expect(toolbarOwner()).toBe("header"));
    await act(async () => {
      navigate("planning");
    });
    await act(async () => {
      navigate("board");
    });

    expect(toolbarOwner()).toBe("header");
    expect(toolbars()).toHaveLength(1);
    expect(document.querySelectorAll("#header-workflow-slot")).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
