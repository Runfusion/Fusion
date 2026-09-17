/*
FNXC:UiStyleAxis 2026-09-15-00:20:
Browser fixture for FN-399's two appearance axes. It mounts REAL production components — the Task Detail
content, a task card and the native primitives that back portaled menus — so the browser lane can measure
composed colour and composed shape rather than a mock.

The measurement contract it enables:
  * changing `data-color-theme` at a FIXED `data-ui-style` must change colour and must NOT change geometry;
  * changing `data-ui-style` at a FIXED `data-color-theme` must change geometry and must NOT change colour.

Both attributes come from the query string and are applied by the sibling HTML before this module runs.
*/

import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { TaskDetail } from "@fusion/core";
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";
import "./components/TaskDetailModal.css";
import "./components/TaskDetailTabStrip.css";
import "./components/TaskCard.css";
import "./components/Column.css";
import "./components/Board.css";
import { TaskDetailContent } from "./components/TaskDetailModal";
import { UiButton, UiListBox, UiListBoxItem, UiSurface } from "./components/ui";
import { ConfirmDialogProvider } from "./hooks/useConfirm";

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { app: {} } },
  defaultNS: "app",
  interpolation: { escapeValue: false },
});

const task = {
  id: "FN-399",
  title: "Interface style measurement task",
  description: "Si je scroll sur mobile le popover du menu more avant de cliquer sur un menu, ça me reset le scroll.",
  column: "in-progress",
  status: "running",
  dependencies: [],
  currentStep: 3,
  steps: [
    { name: "Plan Review", status: "done" },
    { name: "Preflight", status: "done" },
    { name: "Test de reproduction rouge sur `main`", status: "done" },
    { name: "Rendre le focus d'ouverture non destructeur", status: "in-progress" },
    { name: "Couverture des surfaces énumérées", status: "pending" },
    { name: "Code Review", status: "pending" },
  ],
  prompt: "# Task: FN-399\n\n## Mission\nMeasure both appearance axes.\n\n1. First step\n2. Second step\n",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  log: [],
} as unknown as TaskDetail;

const noop = () => undefined;

function Fixture() {
  return (
    <I18nextProvider i18n={i18n}>
      <ConfirmDialogProvider skipConfirmations>
        <div data-testid="ui-style-fixture" style={{ padding: "16px", background: "var(--bg)", minHeight: "100vh" }}>
          {/* A portaled-collection sample: it must inherit the theme like every other surface. */}
          <UiSurface data-testid="fixture-surface" className="card">
            <UiListBox aria-label="Sample collection" data-testid="fixture-listbox">
              <UiListBoxItem id="one" textValue="One" legacyAs="button">One</UiListBoxItem>
              <UiListBoxItem id="two" textValue="Two" legacyAs="button">Two</UiListBoxItem>
            </UiListBox>
            <UiButton data-testid="fixture-button" className="btn">Sample action</UiButton>
          </UiSurface>

          <TaskDetailContent
            embedded
            task={task}
            onDeleteTask={async () => task as never}
            onMergeTask={async () => ({ ok: true }) as never}
            onOpenDetail={noop}
            addToast={noop}
          />
        </div>
      </ConfirmDialogProvider>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
