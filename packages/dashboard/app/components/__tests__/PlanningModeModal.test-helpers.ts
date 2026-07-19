import { vi } from "vitest";
import type { Task, TaskDetail, PlanningQuestion, PlanningSummary, MergeResult } from "@fusion/core";

export const mockStartPlanning = vi.fn();
export const mockStartPlanningStreaming = vi.fn();
export const mockCreatePlanningDraft = vi.fn();
export const mockConnectPlanningStream = vi.fn();
export const mockRespondToPlanning = vi.fn();
export const mockRewindPlanningSession = vi.fn();
export const mockRetryPlanningSession = vi.fn();
export const mockCancelPlanning = vi.fn();
export const mockStopPlanningGeneration = vi.fn();
export const mockUpdatePlanningSessionDraft = vi.fn();
export const mockCreateTaskFromPlanning = vi.fn();
export const mockValidatePlanningSession = vi.fn();
export const mockStartPlanningBreakdown = vi.fn();
export const mockCreateTasksFromPlanning = vi.fn();
export const mockFetchAiSession = vi.fn();
export const mockParseConversationHistory = vi.fn();
export const mockFetchModels = vi.fn();
export const mockAcquireSessionLock = vi.fn();
export const mockReleaseSessionLock = vi.fn();
export const mockForceAcquireSessionLock = vi.fn();
export const mockUploadAttachment = vi.fn();
export const mockDeleteAttachment = vi.fn();
export const mockUpdateTask = vi.fn();
export const mockPauseTask = vi.fn();
export const mockUnpauseTask = vi.fn();
export const mockFetchTaskDetail = vi.fn();
export const mockRequestSpecRevision = vi.fn();
export const mockApprovePlan = vi.fn();
export const mockRejectPlan = vi.fn();
export const mockRefineTask = vi.fn();
export const mockFetchAiSessions = vi.fn();
export const mockDeleteAiSession = vi.fn();

export const mockConfirm = vi.fn();

export const mockUseViewportMode = vi.fn<() => "mobile" | "tablet" | "desktop">(() => "desktop");

export const mockUseMobileKeyboard = vi.fn<() => {
  keyboardOverlap: number;
  viewportHeight: number | null;
  viewportOffsetTop: number;
  keyboardOpen: boolean;
}>(() => ({
  keyboardOverlap: 0,
  viewportHeight: null,
  viewportOffsetTop: 0,
  keyboardOpen: false,
}));

export const mockTasks: Task[] = [
  {
    id: "FN-001",
    description: "Existing task 1",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

export const mockModels = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    contextWindow: 200000,
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    contextWindow: 1048576,
  },
];

export const mockQuestion: PlanningQuestion = {
  id: "q-scope",
  type: "single_select",
  question: "What is the scope?",
  description: "Choose the scope of this task",
  options: [
    { id: "small", label: "Small" },
    { id: "medium", label: "Medium" },
    { id: "large", label: "Large" },
  ],
};

export const mockSummary: PlanningSummary = {
  title: "Build authentication system",
  description: "Implement user auth with login and signup",
  suggestedSize: "M",
  suggestedDependencies: [],
  keyDeliverables: ["Login page", "Signup page", "Auth API"],
};

export const mockTaskDetail = {
  id: "KB-999",
  title: "Example task",
  description: "Example description",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  attachments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# Task\n\nExample prompt",
  paused: false,
} as TaskDetail;

export class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeEventListener(event: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: string, data: unknown): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    const message = { data: JSON.stringify(data) } as MessageEvent;
    listeners.forEach((listener) => listener(message));
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

export function getMediaBlocks(css: string, mediaQuery: string): string[] {
  const blocks: string[] = [];
  let searchStart = 0;

  while (searchStart < css.length) {
    const start = css.indexOf(mediaQuery, searchStart);
    if (start === -1) break;

    const blockStart = css.indexOf("{", start);
    if (blockStart === -1) break;

    let depth = 1;
    let cursor = blockStart + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }

    blocks.push(css.slice(start, cursor));
    searchStart = cursor;
  }

  return blocks;
}

export function mockViewport(mode: "mobile" | "desktop" | "tablet") {
  mockUseViewportMode.mockReturnValue(mode);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)";
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1024px)";
      return {
        matches: mode === "mobile" ? isMobileQuery : mode === "tablet" ? isTabletQuery : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }),
  });
}

export type { Task, TaskDetail, PlanningQuestion, PlanningSummary, MergeResult };
