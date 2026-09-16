import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MainContent } from "./components/dashboard/MainContent";
import type { MainContentProps } from "./components/dashboard/types";
import { FilesView } from "./components/FilesView";
import { FileBrowserModal } from "./components/FileBrowserModal";
import { DockFilesView } from "./components/DockFilesView";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { findOverflowViewEntry } from "./components/overflowViewRegistry";
import { useViewportMode } from "./hooks/useViewportMode";
import "./components/RightDock.css";
import "./components/ProjectSelector.css";
/*
FNXC:FileBrowserScroll 2026-09-17-10:22:
L'ordre d'injection reproduit `main.tsx` : les feuilles de composants (via les imports ci-dessus) AVANT
`styles.css`, `ui-style-tokens.css` puis `native-ui.css`. Une cascade inversée mesurerait un autre gagnant que la
production pour des sélecteurs de même spécificité.
*/
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:FileBrowserScroll 2026-09-17-10:22:
FN-479 : le symptôme signalé (« sur mobile je n'arrive pas à scroller la liste des dossiers/fichiers ») est un
RÉSULTAT RENDU — hauteur réellement calculée, propriétaire de défilement effectif et geste tactile natif. jsdom ne
calcule aucune de ces trois choses, ce qui explique que trois correctifs CSS successifs (FN-427/FN-445/FN-462) soient
restés verts pendant que le symptôme revenait. Cette fixture monte les VRAIS hôtes de production derrière un stub HTTP
déterministe pour que Chromium mesure la composition livrée, jamais une coquille synthétique.

Surfaces exposées par `?surface=` :
- `main`    : routage principal réel `MainContent` (taskView=files, téléphone, projet sélectionné, dock absent)
              → `MainContentDrawer` → `MobileDrawer` → `FilesView` → `DockFilesView` → `FileBrowser`.
- `inline`  : la MÊME page intégrée dans la chaîne de contenu bornée, sans tiroir (`viewMode` hors projet).
- `modal`   : navigateur général `FileBrowserModal` → `FloatingWindow` → `ViewSidebar` → `FileBrowser`.
- `direct`  : `FileBrowserModal(initialFile=…)`, contrôle négatif : vue directe SANS arbre.
- `dock`    : `DockFilesView` dans une colonne de dock bornée (ordinateur).
- `dual`    : deux navigateurs indépendants montés côte à côte.

Les trois sélecteurs de chemin de `SettingsModal` sont délibérément ABSENTS de cette fixture : monter ce modal ici
exigerait de simuler l'intégralité de la charge des réglages (jusqu'à `mcpServers`), et ces sélecteurs ne contiennent
aucun `ViewSidebar`, donc aucun panneau de rail — la boîte où vit la cause. Ils sont couverts par leurs VRAIS
déclencheurs dans `FileBrowser.mobile-layout.test.tsx`, qui résout la chaîne d'ancêtres réelle des trois.
*/

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "main";
const entryCount = Number(params.get("entries") ?? "80");
localStorage.clear();

/*
FNXC:FileBrowserScroll 2026-09-17-10:22:
Jeu déterministe : 80 entrées mixtes, des noms longs, des dossiers navigables et un DERNIER fichier identifiable
(`zz-derniere-entree.txt`) dont l'accessibilité est la preuve du symptôme.
*/
const LAST_ENTRY_NAME = "zz-derniere-entree.txt";
function buildEntries(count: number) {
  const entries: Array<{ name: string; type: "file" | "directory"; size?: number; mtime?: string }> = [];
  for (let index = 0; index < count - 1; index += 1) {
    const padded = String(index).padStart(3, "0");
    entries.push(index % 5 === 0
      ? { name: `dossier-${padded}-avec-un-nom-particulierement-long-pour-le-test`, type: "directory" }
      : { name: `fichier-${padded}-avec-un-nom-particulierement-long.txt`, type: "file", size: 1024 + index, mtime: "2026-01-01T00:00:00.000Z" });
  }
  entries.push({ name: LAST_ENTRY_NAME, type: "file", size: 42, mtime: "2026-01-02T00:00:00.000Z" });
  return entries;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/files/search")) return jsonResponse({ files: [] });
  /* `/files/<chemin>?workspace=…` est la LECTURE d'un fichier ; `/files?workspace=…` est le LISTING. */
  if (/\/files\/[^?]+/.test(url)) return jsonResponse({ content: "contenu du fichier", mtime: "2026-01-02T00:00:00.000Z", size: 42 });
  if (url.includes("/files")) return jsonResponse({ entries: buildEntries(entryCount), path: "." });
  if (url.includes("/workspaces")) return jsonResponse({ project: "Projet 1", tasks: [] });
  if (url.includes("/missions") || url.includes("/roadmaps") || url.includes("/goals") || url.includes("/agents") || url.includes("/nodes")) return jsonResponse([]);
  if (url.includes("/tasks")) return jsonResponse([]);
  if (url.includes("/settings")) return jsonResponse({});
  return jsonResponse({});
};

void i18n.use(initReactI18next).init({
  lng: "fr",
  fallbackLng: "fr",
  resources: { fr: { app: {} } },
  defaultNS: "app",
  interpolation: { escapeValue: false },
});

const noop = () => undefined;
const asyncNoop = async () => undefined;

/*
FNXC:FileBrowserScroll 2026-09-17-10:22:
Le routage `main` doit être le routage RÉEL : `MainContent` décide lui-même du tiroir via
`mobileDrawerEnabled = isMobile && viewMode === "project" && currentProject !== null`. La fixture fournit donc les
entrées de ce prédicat, jamais un `MobileDrawer` monté à la main.
*/
function mainContentProps(overrides: Partial<MainContentProps>): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: asyncNoop,
    shellApi: null,
    taskView: "files",
    modalManager: { closeSettings: noop, openNewTaskWithDescription: noop } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: noop,
    openHistory: noop,
    refreshAppSettings: asyncNoop,
    addToast: noop,
    currentProject: { id: "project-1", name: "Projet 1" } as MainContentProps["currentProject"],
    ChatView: (() => null) as unknown as MainContentProps["ChatView"],
    viewMode: "project",
    tasks: [],
    filteredBoardTasks: [],
    workflowSteps: [],
    remoteData: { tasks: [] } as unknown as MainContentProps["remoteData"],
    capacityRiskBannerEnabled: false,
    capacityRiskDismissed: false,
    capacityRiskSignal: { level: "low", reasons: [] } as unknown as MainContentProps["capacityRiskSignal"],
    maxConcurrent: 2,
    maxWorktrees: 4,
    showWorktreeGrouping: false,
    moveTask: asyncNoop,
    pauseTask: asyncNoop,
    openBoardTaskDetail: noop,
    openTaskDetailInMainPanel: noop,
    openGroupModalWithNav: noop,
    handleBoardQuickCreate: asyncNoop,
    openNewTaskWithNav: noop,
    toggleAutoMerge: asyncNoop,
    togglePlanAutoApprove: asyncNoop,
    autoMerge: true,
    planAutoApproveEnabled: false,
    mergeStrategy: "direct",
    globalPaused: false,
    updateTask: asyncNoop,
    retryTask: asyncNoop,
    revertTask: asyncNoop,
    restoreTaskRevert: asyncNoop,
    deleteTask: asyncNoop,
    searchQuery: "",
    availableModels: [],
    favoriteProviders: [],
    favoriteModels: [],
    handleOpenDetailWithTab: noop,
    handleToggleFavorite: asyncNoop,
    handleToggleModelFavorite: asyncNoop,
    staleHighFanoutBlockerAgeThresholdMs: 0,
    lastFetchTimeMs: undefined,
    prAuthAvailable: false,
    sidebarActive: false,
    isMobile: true,
    isRemote: false,
    experimentalFeatures: {},
    ingestCreatedTasks: noop,
    openDetailTask: noop,
    popOutTaskDetail: noop,
    onOpenChatWithPrefill: noop,
    closeTaskDetailMainPanel: noop,
    setMainPanelDetailTask: noop,
    handleDismissCapacityRisk: noop,
    settingsLoaded: true,
    agentsEnabled: true,
    goalsEnabled: true,
    notesController: {
      notes: [], selected: undefined, pendingSelectedId: undefined, draftTitle: "", draftContent: "",
      dirty: false, saving: false, loading: false, error: null, conflict: null, failedSelectionId: null,
      errorOperation: null, search: "", setSearch: noop, loadList: noop, select: noop, create: noop,
      remove: noop, save: noop, reload: noop, overwrite: noop, clearSelection: noop,
      setDraftTitle: noop, setDraftContent: noop,
    },
    registerNotesGuard: noop,
    pluginDashboardViews: [],
    ...overrides,
  } as unknown as MainContentProps;
}

/*
FNXC:FileBrowserScroll 2026-09-17-10:22:
`data-mobile-drawers` est publié par App (pas par MainContent) avec le MÊME prédicat que `mobileDrawerEnabled`. La
fixture reproduit donc cette publication appartenant au shell, sans inventer d'autre condition.
*/
function Shell({ children, withMobileNav = true, mobileDrawers = false }: { children: React.ReactNode; withMobileNav?: boolean; mobileDrawers?: boolean }) {
  /* Publie `data-viewport-mode` exactement comme le shell de production. */
  const viewportMode = useViewportMode();
  React.useEffect(() => {
    if (!mobileDrawers || viewportMode !== "mobile") {
      delete document.documentElement.dataset.mobileDrawers;
      return;
    }
    document.documentElement.dataset.mobileDrawers = "true";
    return () => { delete document.documentElement.dataset.mobileDrawers; };
  }, [mobileDrawers, viewportMode]);
  /*
  App ne rend AUCUN conteneur supplémentaire entre `#root` et `.project-content` : `#root` est le parent borné
  (`height: 100%; display: flex; flex-direction: column; min-height: 0; overflow: hidden`, styles.css). La fixture
  reproduit exactement cette structure pour ne pas fabriquer une boîte intermédiaire qui n'existe pas en production.
  */
  return (
    <div className={`project-content${withMobileNav ? " project-content--with-mobile-nav" : ""}`}>
      {children}
    </div>
  );
}

function Surface() {
  if (surface === "modal" || surface === "direct") {
    return (
      <Shell mobileDrawers>
        <FileBrowserModal
          projectId="project-1"
          initialFile={surface === "direct" ? "fichier-001-avec-un-nom-particulierement-long.txt" : null}
          onClose={noop}
        />
      </Shell>
    );
  }
  if (surface === "dock" || surface === "dock-expanded") {
    /*
    L'entrée `files` du registre de dock est le VRAI producteur de cette liste côté dock ; la coquille reprend les
    classes de production `.right-dock` / `.right-dock__body` (RightDock.css), qui sont ce qui borne la colonne.
    */
    const entry = findOverflowViewEntry("files")!;
    const rendered = entry.render!({ projectId: "project-1", openFile: noop } as never);
    if (surface === "dock-expanded") {
      return (
        <Shell withMobileNav={false}>
          <div className="modal modal-lg" style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>{rendered}</div>
          </div>
        </Shell>
      );
    }
    return (
      <Shell withMobileNav={false}>
        <div className="right-dock" style={{ inlineSize: 360 }}>
          <div className="right-dock__body">{rendered}</div>
        </div>
      </Shell>
    );
  }
  if (surface === "dual") {
    return (
      <Shell withMobileNav={false}>
        <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
          <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }} data-testid="dual-a"><DockFilesView projectId="project-1" openFile={noop} /></div>
          <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }} data-testid="dual-b"><DockFilesView projectId="project-2" openFile={noop} /></div>
        </div>
      </Shell>
    );
  }
  if (surface === "inline") {
    /* La MÊME page, hors tiroir : chaîne de contenu bornée, aucun `data-mobile-drawers`. */
    return (
      <Shell>
        <FilesView projectId="project-1" openFile={noop} />
      </Shell>
    );
  }
  return (
    <Shell mobileDrawers>
      <MainContent {...mainContentProps({})} />
    </Shell>
  );
}

function Fixture() {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <NavigationHistoryProvider value={{ pushNav: noop, replaceCurrent: noop, removeNav: noop, promoteNav: noop }}>
            <ViewLayoutProvider projectId="project-1">
              <Surface />
            </ViewLayoutProvider>
          </NavigationHistoryProvider>
        </ConfirmDialogProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
