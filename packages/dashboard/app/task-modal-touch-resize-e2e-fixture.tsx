import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import "./styles.css";
import "./components/TaskDetailModal.css";
import "./components/FloatingWindow.css";
import { FloatingWindow } from "./components/FloatingWindow";
import { NewTaskModal } from "./components/NewTaskModal";
import { AgentListModal } from "./components/AgentListModal";
import { SetupWizardModal } from "./components/SetupWizardModal";
import { ConfirmDialogProvider } from "./hooks/useConfirm";

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "new-task";
if (params.has("reset")) localStorage.clear();

/*
FNXC:ModalTouchGeometry 2026-07-26-20:08:
Task Detail now uses FloatingWindow geometry in production. Seed its shared size-and-position payload
only for resize gestures that need headroom; density assertions continue to use the default geometry.
*/
const detailSize = params.get("detailSize");
if (detailSize) {
  const [width, height] = detailSize.split("x").map(Number);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    localStorage.setItem("floating-window:task-detail", JSON.stringify({ size: { width, height }, position: { x: 64, y: 64 } }));
  }
}

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { app: {} } },
  interpolation: { escapeValue: false },
});

/*
FNXC:ModalTouchGeometry 2026-07-27-09:15:
The FN-8607 evidence surfaces mount the migrated production modals, not lookalike harnesses.
The wizard deliberately uses its standalone default first step; `includeAgentStep={false}` would instead
render the parent onboarding flow's Step 3 of 5 project sub-flow and misrepresent the required capture.
Their minimal API payloads keep first render deterministic so the CDP assertions prove FloatingWindow
geometry before each committed screenshot is captured.
*/
window.fetch = async (input) => {
  const url = String(input);
  const payload = url.includes("/models")
    ? { models: [], favoriteProviders: [], favoriteModels: [] }
    : url.includes("/settings") ? {}
      : url.includes("/agents") || url.includes("/nodes") ? []
        : [];
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
};

function TaskDetailResizeHarness() {
  return <FloatingWindow
    windowKey="task-detail-fixture"
    title="Task detail"
    onClose={() => undefined}
    hideHeader
    dragHandleSelector=".task-detail-content--embedded > .modal-header"
    className="floating-window--task-detail"
    defaultSize={{ width: 560, height: 480 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="floating-window:task-detail"
    suspendGeometryPersistenceOnMobile
    layer="task-detail"
    testId="task-detail-modal-overlay"
  >
    <div className="task-detail-content task-detail-content--embedded">
      <div className="modal-header">Task detail</div>
      <div className="modal-body">Task detail body</div>
    </div>
  </FloatingWindow>;
}

function FloatingWindowHarness() {
  return <FloatingWindow
    windowKey="fn-8605-floating"
    title="Floating task detail"
    onClose={() => undefined}
    className="floating-window--task-detail"
    defaultSize={{ width: 560, height: 480 }}
    defaultPosition={{ x: 80, y: 80 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="fusion:fn-8605-floating"
    suspendGeometryPersistenceOnMobile
  >
    <div>Floating task detail body</div>
  </FloatingWindow>;
}

function HeaderlessFloatingWindowHarness() {
  const [actionCount, setActionCount] = useState(0);
  return <FloatingWindow
    windowKey="fn-8605-headerless-floating"
    title="Headerless floating task detail"
    onClose={() => undefined}
    hideHeader
    dragHandleSelector=".fn-8605-delegated-drag-handle"
    className="floating-window--task-detail"
    defaultSize={{ width: 560, height: 480 }}
    defaultPosition={{ x: 80, y: 80 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="fusion:fn-8605-headerless-floating"
    suspendGeometryPersistenceOnMobile
  >
    <div className="fn-8605-delegated-drag-handle">Headerless task detail
      <button type="button" data-testid="fn-8605-header-action" onClick={() => setActionCount((count) => count + 1)}>Header action</button>
      <output data-testid="fn-8605-header-action-count">{actionCount}</output>
    </div>
    <div>Floating task detail body</div>
  </FloatingWindow>;
}

/*
FNXC:ModalTouchGeometry 2026-07-26-15:30:
This intentionally classless headerless window is the browser control for every non-task
FloatingWindow consumer. It must retain the shared 44px layout target while task detail moves
its target out of flow.
*/
function GenericFloatingWindowHarness() {
  return <FloatingWindow
    windowKey="fn-8612-generic-floating"
    title="Generic floating window"
    onClose={() => undefined}
    hideHeader
    dragHandleSelector=".fn-8612-generic-drag-handle"
    defaultSize={{ width: 560, height: 480 }}
    defaultPosition={{ x: 80, y: 80 }}
    minSize={{ width: 320, height: 240 }}
    persistGeometryKey="fusion:fn-8612-generic-floating"
    suspendGeometryPersistenceOnMobile
  >
    <div className="fn-8612-generic-drag-handle">Generic window header</div>
    <div>Generic floating window body</div>
  </FloatingWindow>;
}

function Fixture() {
  return <I18nextProvider i18n={i18n}>
    <ConfirmDialogProvider skipConfirmations>
      {surface === "agent-list-modal" ? <AgentListModal isOpen onClose={() => undefined} addToast={() => undefined} /> : surface === "setup-wizard-modal" ? <SetupWizardModal onProjectRegistered={() => undefined} onClose={() => undefined} /> : surface === "floating-window" ? <FloatingWindowHarness /> : surface === "floating-window-headerless" ? <HeaderlessFloatingWindowHarness /> : surface === "floating-window-generic" ? <GenericFloatingWindowHarness /> : surface === "task-detail" ? <TaskDetailResizeHarness /> : <NewTaskModal
        isOpen
        tasks={[]}
        onClose={() => undefined}
        onCreateTask={async () => ({ id: "FN-E2E" }) as never}
        addToast={() => undefined}
      />}
    </ConfirmDialogProvider>
  </I18nextProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
