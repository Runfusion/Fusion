import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { PlanningDrawer } from "./components/MobileDrawer";
import { MainContentDrawer } from "./components/dashboard/MainContent";
import { PlanningModeModal } from "./components/PlanningModeModal";
import { MissionManager } from "./components/MissionManager";
import { ViewHeader } from "./components/ViewHeader";
import { ViewActionButton } from "./components/ViewActionButton";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
import { useViewportMode } from "./hooks/useViewportMode";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
/*
FNXC:MobileDrawerGesture 2026-09-17-03:18:
L'ordre d'injection reproduit `main.tsx` : feuilles de composants (via les imports ci-dessus) AVANT `styles.css`,
`ui-style-tokens.css` puis `native-ui.css`. Une cascade inversée mesurerait un autre gagnant que la production pour
des sélecteurs de même spécificité — exactement le mécanisme qui rendait inerte la taille déclarée du chevron Retour.
*/
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:MobileDrawerGesture 2026-09-17-03:18:
FN-486 : le symptôme d'origine est un RÉSULTAT RENDU — un tiré vers le bas depuis une ligne de liste déjà au sommet
doit fermer le tiroir, un appui long doit poser un menu entièrement dans le viewport, et le bouton Retour doit avoir
la même géométrie que le « + ». jsdom ne calcule ni la géométrie ni le geste tactile natif, donc cette fixture monte
les VRAIS ponts de tiroir de production derrière un stub HTTP déterministe.

Surfaces exposées par `?surface=` :
- `planning` : `PlanningDrawer` (pont App) → `MobileDrawer` → `PlanningModeModal` intégré.
- `missions` : `MainContentDrawer` (pont MainContent) → `MobileDrawer` → `MissionManager` intégré.
- `header`   : en-tête partagé seul, avec son retour et son action de création, pour la mesure de parité.
*/

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "planning";
localStorage.clear();

const stamps = { createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };

function planningSessions() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `session-${index}`,
    title: `Session de planification numéro ${index} avec un titre volontairement long`,
    projectId: "project-1",
    type: "planning",
    status: index % 3 === 0 ? "complete" : "awaiting_input",
    archived: false,
    conversationHistory: "[]",
    thinkingOutput: "",
    ...stamps,
  }));
}

function missions() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `M-${index}`,
    title: `Mission numéro ${index} avec un titre volontairement long pour le test`,
    description: "",
    status: index % 2 === 0 ? "active" : "planning",
    interviewState: "completed",
    autoAdvance: false,
    autopilotEnabled: false,
    autopilotState: "inactive",
    milestones: [],
    summary: { totalMilestones: 0, totalFeatures: 0, completedMilestones: 0, completedFeatures: 0, progressPercent: 0 },
    ...stamps,
  }));
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/*
FNXC:MobileDrawerGesture 2026-09-17-04:31:
`fetchAiSessions` lit `data.sessions` et non un tableau nu : une collection nue laissait la liste Planning vide, donc
sans ligne à saisir. Les sessions d'entretien Missions passent par le même point d'entrée, filtré par `type`.
*/
window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/ai-sessions")) {
    const isInterview = url.includes("type=mission_interview");
    return jsonResponse({ sessions: isInterview ? [] : planningSessions() });
  }
  if (url.includes("/missions/health")) return jsonResponse({});
  if (url.includes("/mission-interview")) return jsonResponse([]);
  if (url.includes("/missions")) return jsonResponse(missions());
  if (url.includes("/workflows")) return jsonResponse({ workflows: [] });
  if (url.includes("/models")) return jsonResponse({ models: [], favoriteProviders: [], favoriteModels: [] });
  if (url.includes("/settings")) return jsonResponse({});
  if (url.includes("/tasks")) return jsonResponse([]);
  return jsonResponse({});
};

/* Le flux SSE n'est pas le sujet ici : un flux inerte évite toute reconnexion pendant la mesure des gestes. */
class InertEventSource {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.readyState = 2; }
}
window.EventSource = InertEventSource as unknown as typeof EventSource;

void i18n.use(initReactI18next).init({
  lng: "fr",
  fallbackLng: "fr",
  resources: { fr: { app: {} } },
  defaultNS: "app",
  interpolation: { escapeValue: false },
});

function HeaderParitySurface() {
  return (
    <ViewHeader
      title="Un titre de destination volontairement très long pour comprimer la rangée"
      backAction={{ label: "Retour à la liste", "data-testid": "parity-back", onClick: () => undefined }}
      actions={<ViewActionButton kind="create" label="Nouvel élément" data-testid="parity-create" onClick={() => undefined} />}
    />
  );
}

/*
FNXC:MobileDrawerGesture 2026-09-17-04:31:
La présentation icône seule, la boîte canonique du retour ET la hauteur bornée du panneau de tiroir
(`--mobile-drawer-block-size`) sont toutes conditionnées par les attributs de document publiés par le shell :
`data-viewport-mode` par `useViewportMode` et `data-mobile-drawers` par App, avec le même prédicat que
`mobileDrawerEnabled`. La fixture appelle donc le VRAI hook et reproduit cette unique publication de shell ;
sans elle le panneau n'est pas borné, la liste n'a aucun propriétaire de défilement et le geste mesuré ne serait
pas celui de la production.
*/
function Fixture() {
  const viewportMode = useViewportMode();
  useEffect(() => {
    if (viewportMode !== "mobile") {
      delete document.documentElement.dataset.mobileDrawers;
      return;
    }
    document.documentElement.dataset.mobileDrawers = "true";
    return () => { delete document.documentElement.dataset.mobileDrawers; };
  }, [viewportMode]);
  const [planningOpen, setPlanningOpen] = useState(true);
  const [missionsOpen, setMissionsOpen] = useState(true);
  if (surface === "header") return <HeaderParitySurface />;
  if (surface === "missions") {
    return (
      <div className="project-content project-content--with-mobile-nav">
        <MainContentDrawer taskView="missions" open={missionsOpen} title="Missions" onClose={() => setMissionsOpen(false)}>
          <MissionManager isInline isOpen onClose={() => undefined} addToast={() => undefined} projectId="project-1" />
        </MainContentDrawer>
      </div>
    );
  }
  return (
    <div className="project-content project-content--with-mobile-nav">
      <PlanningDrawer open={planningOpen} title="Planning" onClose={() => setPlanningOpen(false)}>
        <PlanningModeModal isOpen onClose={() => undefined} onTaskCreated={() => undefined} onTasksCreated={() => undefined} tasks={[]} projectId="project-1" presentation="embedded" />
      </PlanningDrawer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <NavigationHistoryProvider value={{ pushNav: () => undefined, replaceCurrent: () => undefined, removeNav: () => undefined, promoteNav: () => undefined }}>
            <ViewLayoutProvider>
              <Fixture />
            </ViewLayoutProvider>
          </NavigationHistoryProvider>
        </ConfirmDialogProvider>
      </ToastProvider>
    </I18nextProvider>
  </React.StrictMode>,
);
