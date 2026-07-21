import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { PlanningModeModal } from "./components/PlanningModeModal";
import { ToastProvider } from "./hooks/useToast";
import { NavigationHistoryProvider } from "./hooks/useNavigationHistory";

const summary = {
  title: "Adaptive planning workflow",
  description: "An evolving **operator-ready** plan assembled from the interview answers.",
  proposedChanges: [
    "Render the canonical plan as Markdown",
    "Keep review actions reachable while the plan scrolls",
    "Generate the initial plan in a real AI session",
    "Open refinement areas only from the Refine action",
    "Allow multiple suggested refinement areas",
    "Accept an operator-authored refinement focus",
    "Ask one focused question after refinement",
    "Return to plan review after each answer",
    "Preserve the plan document while refinement is open",
    "Keep the refinement menu usable on narrow screens",
    "Expose a clear Proceed with plan action",
    "Persist the reviewed Markdown as the task plan",
  ],
  acceptanceCriteria: ["Markdown structure is visible", "Mobile actions remain at the bottom of the planning pane"],
  suggestedSize: "M",
  priority: "normal",
  suggestedDependencies: [],
  keyDeliverables: ["Adaptive questions", "Validated task", "Responsive plan review"],
  suggestedRefinements: ["Security boundaries", "Rollout strategy", "Failure recovery", "Accessibility", "Observability", "Data migration", "Performance", "Operational readiness", "API compatibility", "Privacy", "Analytics", "Localization", "Offline behavior", "Permissions", "Documentation", "Support readiness"],
};

const showPlanReview = new URLSearchParams(window.location.search).get("surface") === "plan-review";

const questions = [
  {
    id: "q-goal",
    type: "single_select",
    question: "Which user outcome matters most?",
    options: [
      { id: "speed", label: "Speed", pros: "Fast delivery", cons: "Less breadth" },
      { id: "depth", label: "Depth", pros: "More complete", cons: "Takes longer" },
    ],
  },
  {
    id: "q-audience",
    type: "single_select",
    question: "Who should receive this first?",
    options: [
      { id: "operators", label: "Operators", pros: "Immediate feedback", cons: "Narrow audience" },
      { id: "everyone", label: "Everyone", pros: "Broad value", cons: "More coordination" },
    ],
  },
  {
    id: "q-rollout",
    type: "single_select",
    question: "How should the rollout be measured?",
    options: [
      { id: "pilot", label: "Pilot", pros: "Lower risk", cons: "Slower reach" },
      { id: "release", label: "Release", pros: "Faster reach", cons: "Higher risk" },
    ],
  },
];

const streams = new Set<MockEventSource>();

class MockEventSource {
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  constructor(_url: string) {
    streams.add(this);
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void { this.readyState = 2; streams.delete(this); }
  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

window.EventSource = MockEventSource as unknown as typeof EventSource;

function emitTurn(questionIndex: number): void {
  setTimeout(() => {
    streams.forEach((stream) => stream.emit("summary", summary));
    streams.forEach((stream) => stream.emit("question", questions[questionIndex]));
  }, 20);
}

function emitSummary(): void {
  setTimeout(() => {
    streams.forEach((stream) => stream.emit("summary", summary));
  }, 20);
}

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.includes("/planning/start-streaming") && method === "POST") {
    emitSummary();
    return json({ sessionId: "planning-browser-e2e" });
  }
  if (url.includes("/planning/respond") && method === "POST") {
    const body = typeof init.body === "string" ? JSON.parse(init.body) as { responses?: { refine?: boolean } } : {};
    if (body.responses?.refine) {
      emitTurn(1);
      return json({ sessionId: "planning-browser-e2e", currentQuestion: questions[1], summary });
    }
    emitSummary();
    return json({ sessionId: "planning-browser-e2e", currentQuestion: null, summary });
  }
  if (url.includes("/planning/planning-browser-e2e/back") && method === "POST") {
    emitTurn(0);
    return json({ currentQuestion: questions[0], summary, history: [] });
  }
  if (url.includes("/planning/planning-browser-e2e/validate") && method === "POST") return json({ summary, validated: true });
  if (url.includes("/planning/create-task") && method === "POST") return json({ task: { id: "FN-BROWSER", description: summary.description, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, alreadyCreated: false });
  if (showPlanReview && url.includes("/ai-sessions/planning-browser-e2e")) {
    return json({ id: "planning-browser-e2e", title: summary.title, projectId: "project-browser", status: "awaiting_input", currentQuestion: null, result: JSON.stringify(summary), inputPayload: "{}", conversationHistory: "[]", thinkingOutput: "", updatedAt: new Date().toISOString(), archived: false });
  }
  if (url.includes("/ai-sessions")) return json({ sessions: [] });
  if (url.includes("/models")) return json({ models: [], favoriteProviders: [], favoriteModels: [] });
  if (url.includes("/settings")) return json({});
  if (url.includes("/events") || url.includes("/diagnostics/resume-events")) return json({ success: true });
  if (url.includes("/planning/create-draft")) return json({ sessionId: "planning-browser-e2e", title: "Adaptive planning workflow" });
  if (url.includes("/planning/")) return json({ success: true });
  return originalFetch(input, init);
};

void i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: { en: { app: {} } }, interpolation: { escapeValue: false } });

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <NavigationHistoryProvider value={{ pushNav: () => undefined, replaceCurrent: () => undefined, removeNav: () => undefined }}>
    <ToastProvider>
      <PlanningModeModal
        isOpen
        onClose={() => undefined}
        onTaskCreated={(task) => { document.body.dataset.createdTask = task.id; }}
        onTasksCreated={() => undefined}
        tasks={[]}
        presentation="embedded"
        resumeSessionId={showPlanReview ? "planning-browser-e2e" : undefined}
      />
    </ToastProvider>
    </NavigationHistoryProvider>
  </I18nextProvider>,
);
