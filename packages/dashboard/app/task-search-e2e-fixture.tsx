import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { Task } from "@fusion/core";
import "./styles.css";
import { Column } from "./components/Column";
import { TaskSearchInput } from "./components/TaskSearchInput";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmDialogProvider } from "./hooks/useConfirm";
import { useState } from "react";

/*
FNXC:TaskSearch 2026-09-17-09:41:
FN-477's sizing contract is a RENDERED result: a result card must measure like a board card, and the
panel must reserve one complete card plus half of the next before scrolling. jsdom computes neither —
it returns zero rectangles and never runs the flex/overflow layout — so this fixture mounts the real
`TaskSearchInput` (with its real controller hook and result cards) NEXT TO a real board `Column`, and
a real Chromium measures both.

Only the HTTP boundary is stubbed, and deterministically: the same twelve tasks every run.
*/

const params = new URLSearchParams(window.location.search);
const resultCount = Number(params.get("results") ?? "12");

function makeTask(index: number): Task {
  return {
    id: `FN-${300 + index}`,
    title: index === 0
      ? "le bouton collapse du leftsidebar doit être au header de la sidebar et être du meme design que le bouton qui collapse la rightsidebar."
      : `collapse ${index} — une tâche de recherche`,
    description: index % 3 === 0 ? "Description plus longue pour faire varier la hauteur des cartes de résultat." : "",
    column: index % 2 === 0 ? "todo" : "in-progress",
    steps: index % 4 === 0 ? [{ name: "Préflight", status: "done" }, { name: "Implémentation", status: "in-progress" }] : [],
    dependencies: [],
    createdAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: "2026-02-01T00:00:00.000Z",
  } as unknown as Task;
}

const allTasks = Array.from({ length: resultCount }, (_unused, index) => makeTask(index));

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("/tasks/page")) {
    // One page: the panel's scroll surface, not pagination, is what this fixture measures.
    return jsonResponse({ tasks: allTasks, total: allTasks.length, hasMore: false, nextCursor: null });
  }
  if (url.includes("/ai/search-tasks")) {
    return jsonResponse({ query: "collapse", tasks: allTasks.slice(0, 5) });
  }
  /*
  Array-shaped endpoints must answer with an array. A blanket `{}` fallback made `PluginSlot` throw
  `slots.filter is not a function` inside the board `Column`, which stopped the fixture from ever
  rendering the panel this suite exists to measure.
  */
  if (/\/(agents|plugins\/ui-slots|goals|missions|scripts|schedules|artifacts)/.test(url)) {
    return jsonResponse([]);
  }
  if (url.includes("/workflows")) {
    return jsonResponse({ flagEnabled: false, defaultWorkflowId: null, workflows: [], taskWorkflowIds: {} });
  }
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
  const [query, setQuery] = useState("collapse");
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ConfirmDialogProvider>
          <div className="header" style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px" }}>
            <div className="header-actions" style={{ display: "flex" }}>
              {/* autoFocus opens the panel on load, exactly as clicking the header Search icon does. */}
              <TaskSearchInput
                query={query}
                projectId="project-1"
                onSearchChange={setQuery}
                onSelectTask={() => undefined}
                autoFocus
                className="header-search--inline"
                testId="fixture-header-search-input"
              />
            </div>
          </div>
          {/*
          A real board column so the test can compare a result card against the genuine board card.
          The grid deliberately uses the production six-column `minmax(300px, 1fr)` template: a single
          full-width column would make a card ~1400px wide at 1440px, and the width comparison would
          pass for a panel that is in fact nothing like a board column.
          */}
          <div className="board" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(300px, 1fr))", flex: 1, minHeight: 0, overflowX: "auto" }}>
            <Column
              column="todo"
              tasks={allTasks.slice(0, 3)}
              projectId="project-1"
              maxConcurrent={2}
              maxWorktrees={2}
              showWorktreeGrouping={false}
              onMoveTask={async (_id, _column) => allTasks[0]}
              onOpenDetail={() => undefined}
              addToast={() => undefined}
            />
          </div>
        </ConfirmDialogProvider>
      </ToastProvider>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
