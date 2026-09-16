import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { Goal } from "@fusion/core";
import "./styles.css";
import { GoalsView } from "./components/GoalsView";
import { NotesView } from "./components/NotesView";
/* FNXC:UniversalViewChrome 2026-09-16-21:44: FN-476 measures the operator-named Snippets destination in a real engine too. */
import { SnippetsView } from "./components/SnippetsView";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";

/*
FNXC:StandardizedViewLayout 2026-09-13-20:32:
FN-379's geometry contract (shared rail width, header action placement, tactile back target, phone pane exclusivity,
no document pan) is a RENDERED result, so jsdom cannot prove it. This fixture mounts the real destinations behind a
deterministic HTTP stub so real Chromium measures the production compositions rather than a synthetic shell.
*/

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "goals";
localStorage.clear();

const notes = [
  { id: "note-1", title: "Première note", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "note-2", title: "Deuxième note", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
];

const goals: Goal[] = [
  { id: "G-1", title: "Livraison autonome fiable", description: "Objectif principal", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as Goal,
  { id: "G-2", title: "Interfaces standardisées", description: "Second objectif", status: "active", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" } as Goal,
];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/notes/")) {
    const id = url.split("/notes/")[1]?.split("?")[0] ?? "note-1";
    const summary = notes.find((note) => note.id === id) ?? notes[0];
    return jsonResponse({ ...summary, content: "Contenu de la note", revision: 1 });
  }
  if (url.includes("/notes")) return jsonResponse({ notes });
  if (url.includes("/goals")) return jsonResponse(goals);
  if (url.includes("/settings/global")) {
    return jsonResponse({ chatSnippets: [{ name: "revue", prompt: "Relis le diff" }, { name: "tests", prompt: "Lance les tests" }] });
  }
  if (url.includes("/missions")) return jsonResponse([]);
  return jsonResponse({});
};

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { app: {} } },
  defaultNS: "app",
  interpolation: { escapeValue: false },
});

function Fixture() {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <NavigationHistoryProvider value={{ pushNav: () => undefined, replaceCurrent: () => undefined, removeNav: () => undefined, promoteNav: () => undefined }}>
            <ViewLayoutProvider projectId="project-1">
              {surface === "notes"
                ? <NotesView projectId="project-1" addToast={() => undefined} />
                : surface === "snippets"
                  ? <SnippetsView />
                  : <GoalsView projectId="project-1" initialGoals={goals} />}
            </ViewLayoutProvider>
          </NavigationHistoryProvider>
        </ConfirmDialogProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
