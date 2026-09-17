import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { Column as ColumnType, Task } from "@fusion/core";
import { Board } from "./components/Board";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, writeBoardWorkflowSelection } from "./utils/boardWorkflowSelection";
/*
FNXC:BoardNavigation 2026-09-17-09:49:
L'ordre d'injection reproduit `main.tsx` : les feuilles de composants (via les imports ci-dessus) AVANT
`styles.css`, `ui-style-tokens.css` puis `native-ui.css`. Une cascade inversée mesurerait un autre gagnant que la
production pour des sélecteurs de même spécificité — et c'est précisément la cascade de `scroll-snap-type` /
`touch-action` du tableau qui est en jeu ici.
*/
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 : « le scroll horizontal du board me déplace de colonnes en colonnes de façon sèche et non fluide ». La
fluidité, l'ancrage exact et l'absence d'arrêt intermédiaire sont des RÉSULTATS RENDUS : ils dépendent du layout
flex réel, de la cascade `scroll-snap-type`/`touch-action` et du pipeline d'entrée tactile natif, dont jsdom ne
calcule aucun. Cette fixture monte donc le VRAI `Board` (les deux vues, sélection et agrégat) derrière un stub HTTP
déterministe, sans daemon, sans PostgreSQL et sans appel IA.

Surfaces exposées par `?surface=` :
- `selected`  : vue d'un workflow sélectionné (chemin `selectedWorkflow` de `Board`).
- `aggregate` : vue « All workflows » (chemin agrégé de `Board`).
*/
const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "selected";
localStorage.clear();
sessionStorage.clear();

const WORKFLOW = {
  id: "builtin:coding",
  name: "Coding",
  columns: [
    { id: "todo", name: "Todo", flags: { hold: true } },
    { id: "in-progress", name: "In Progress", flags: {} },
    { id: "in-review", name: "In Review", flags: { review: true } },
    { id: "blocked", name: "Blocked", flags: {} },
    { id: "done", name: "Done", flags: { complete: true } },
  ],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/board-workflows") || url.includes("/workflows")) {
    return jsonResponse({ defaultWorkflowId: WORKFLOW.id, workflows: [WORKFLOW], taskWorkflowIds: {} });
  }
  if (url.includes("/settings")) return jsonResponse({});
  if (
    url.includes("/nodes")
    || url.includes("/agents")
    || url.includes("/missions")
    || url.includes("/roadmaps")
    || url.includes("/goals")
    || url.includes("/tasks")
    || url.includes("/plugins")
  ) {
    return jsonResponse([]);
  }
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

function task(id: string, column: string): Task {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: `Tâche ${id} avec un titre volontairement long`,
    description: "",
    column: column as ColumnType,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    columnMovedAt: timestamp,
  } as Task;
}

/** Colonnes remplies ET colonnes vides : la géométrie d'ancrage ne doit dépendre ni de l'une ni de l'autre. */
const TASKS: Task[] = [
  task("FN-001", "todo"),
  task("FN-002", "todo"),
  task("FN-003", "in-progress"),
  task("FN-004", "in-review"),
  task("FN-005", "done"),
];

// La vue agrégée est sélectionnée par le MÊME écrivain de préférence que la production, avant le montage.
if (surface === "aggregate") writeBoardWorkflowSelection("project-1", ALL_WORKFLOWS_BOARD_VIEW_ID);

function Fixture() {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <NavigationHistoryProvider value={{ pushNav: noop, replaceCurrent: noop, removeNav: noop, promoteNav: noop }}>
            <ViewLayoutProvider projectId="project-1">
              {/* App ne rend aucun conteneur suppl\u00e9mentaire entre #root et .project-content. */}
              <div className="project-content project-content--with-mobile-nav">
                <Board
                  tasks={TASKS}
                  projectId="project-1"
                  maxConcurrent={2}
                  maxWorktrees={4}
                  showWorktreeGrouping={false}
                  onMoveTask={asyncNoop as never}
                  onOpenDetail={noop}
                  addToast={noop}
                  onNewTask={noop}
                  autoMerge
                  onToggleAutoMerge={asyncNoop as never}
                  planAutoApproveEnabled={false}
                  onTogglePlanAutoApprove={asyncNoop as never}
                />
              </div>
            </ViewLayoutProvider>
          </NavigationHistoryProvider>
        </ConfirmDialogProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
