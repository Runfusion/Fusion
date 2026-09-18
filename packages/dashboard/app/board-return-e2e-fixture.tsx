import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { PlanningKeepAlive } from "./components/dashboard/PlanningKeepAlive";
import { PlanningDrawer } from "./components/MobileDrawer";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
import {
  BOARD_RETURN_SECONDARY_WORKFLOW,
  BOARD_RETURN_TASKS,
  BOARD_RETURN_WORKFLOW,
  BoardViewReturnHarness,
} from "./test/boardViewReturnFixture";
/*
FNXC:BoardNavigation 2026-09-18-02:12:
Ordre d'injection identique à `main.tsx` : feuilles de composants (via les imports ci-dessus) AVANT `styles.css`,
`ui-style-tokens.css` puis `native-ui.css`. Une cascade inversée mesurerait un autre gagnant que la production pour
les règles de hauteur partagées de `.project-content` et de `.keep-alive-view`.
*/
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:BoardNavigation 2026-09-18-02:12:
FN-522 : le déplacement du tableau au retour de Planning/Missions est un RÉSULTAT RENDU (rectangles, hauteurs,
offsets de défilement d'un conteneur `overflow: hidden`). jsdom n'en calcule aucun, donc cette fixture pilote les
vrais hôtes dans un vrai Chromium : Header réel, routage MainContent réel, Planning conservé réel.
*/

localStorage.clear();
sessionStorage.clear();

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/board-workflows") || url.includes("/workflows")) {
    return jsonResponse({
      defaultWorkflowId: BOARD_RETURN_WORKFLOW.id,
      workflows: [BOARD_RETURN_WORKFLOW, BOARD_RETURN_SECONDARY_WORKFLOW],
      taskWorkflowIds: {},
    });
  }
  if (url.includes("/missions")) {
    /* Une mission détaillée assez longue : la vue Missions doit vraiment défiler pour reproduire le défaut. */
    return jsonResponse(
      Array.from({ length: 24 }, (_, index) => ({
        id: `M-${index + 1}`,
        title: `Mission ${index + 1} avec un intitulé volontairement long`,
        description: "Description de mission suffisamment longue pour faire défiler la page Missions.",
        status: "active",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
        milestones: [],
      })),
    );
  }
  if (url.includes("/settings")) return jsonResponse({});
  if (url.includes("/sessions") || url.includes("/ai-sessions")) return jsonResponse([]);
  return jsonResponse([]);
};

void i18n.use(initReactI18next).init({
  lng: "fr",
  fallbackLng: "fr",
  resources: { fr: { app: {} } },
  defaultNS: "app",
  interpolation: { escapeValue: false },
});

const params = new URLSearchParams(window.location.search);
const isMobile = params.get("viewport") === "mobile";

const noop = () => undefined;

const planningModalManager = {
  closePlanning: noop,
  closeSettings: noop,
  clearPlanningInitialPlan: noop,
  planningEntryGeneration: 0,
  planningInitialPlan: null,
  planningSourceIssue: undefined,
  planningWorkflowId: null,
  planningResumeSessionId: undefined,
  detailTask: null,
  anyModalOpen: false,
} as never;

function Fixture() {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <NavigationHistoryProvider value={{ pushNav: noop, replaceCurrent: noop, removeNav: noop, promoteNav: noop }}>
            <ViewLayoutProvider projectId="project-1">
              <BoardViewReturnHarness
                isMobile={isMobile}
                planningSibling={(active) => {
                  /*
                  FNXC:BoardNavigation 2026-09-18-02:12:
                  Mêmes ponts que `App` : sur téléphone Planning s'ouvre dans `PlanningDrawer` AU-DESSUS d'un Board de
                  fond actif (qui garde le slot, FN-483) ; sur tablette/ordinateur c'est une vraie page conservée.
                  */
                  const host = (
                    <PlanningKeepAlive
                      active={active}
                      showWorkflowControls={!isMobile}
                      projectId="project-1"
                      tasks={BOARD_RETURN_TASKS}
                      bgPlanningSessions={[]}
                      modalManager={planningModalManager}
                      handleChangeTaskView={noop}
                      handlePlanningTaskCreated={noop}
                      handlePlanningTasksCreated={noop}
                      openBoardTaskDetail={noop}
                    />
                  );
                  if (!isMobile) return host;
                  return (
                    <PlanningDrawer open={active} title="Planning" onClose={noop}>
                      {host}
                    </PlanningDrawer>
                  );
                }}
              />
            </ViewLayoutProvider>
          </NavigationHistoryProvider>
        </ConfirmDialogProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
