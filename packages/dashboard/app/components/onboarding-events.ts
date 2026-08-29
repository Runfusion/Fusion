import type { OnboardingStep } from "./model-onboarding-state";

/** LocalStorage key used for persisted onboarding funnel events. */
const ONBOARDING_EVENTS_STORAGE_KEY = "fusion_onboarding_events";
/** SessionStorage key used for tab-scoped onboarding session IDs. */
const ONBOARDING_SESSION_ID_STORAGE_KEY = "fusion_onboarding_session_id";
/** Maximum number of events kept in localStorage before pruning. */
const ONBOARDING_EVENTS_MAX = 200;
/** Number of oldest events removed per prune operation. */
const ONBOARDING_EVENTS_PRUNE_BATCH = 50;

/**
 * Known onboarding funnel event names.
 */
export type OnboardingEventType =
  | "onboarding:wizard-opened"
  | "onboarding:step-completed"
  | "onboarding:step-skipped"
  | "onboarding:dismissed"
  | "onboarding:completed"
  | "onboarding:finished"
  | "onboarding:first-task-created"
  | "onboarding:open-new-task"
  | "onboarding:open-github-import"
  | "onboarding:resumed"
  | "onboarding:auto-triggered";

/**
 * Source metadata for wizard-opened events.
 *
 * Includes legacy values (`"resume"`, `"initial"`) to preserve compatibility
 * with existing instrumentation call sites while funnel analytics migrate to
 * the canonical source labels.
 */
export type OnboardingWizardOpenedSource =
  | "auto-trigger"
  | "resume-card"
  | "settings"
  | "unknown"
  | "resume"
  | "initial";

/**
 * Structured onboarding analytics event persisted in localStorage.
 */
export interface OnboardingEvent {
  /** Event name (for example: "onboarding:step-completed"). */
  type: string;
  /** Event timestamp in ISO-8601 format. */
  timestamp: string;
  /** Optional duplicated step index for convenience querying. */
  step?: OnboardingStep;
  /** Event-specific metadata payload. */
  metadata: Record<string, unknown>;
  /** Session-scoped identifier persisted in sessionStorage. */
  sessionId: string;
}

/**
 * Emits an onboarding funnel event, persists it to localStorage (ring buffer),
 * and logs it to console.info in development mode.
 *
 * Event names expected by this module:
 * - `onboarding:wizard-opened` → `{ source, resumedFromStep? }`
 * - `onboarding:step-completed` → `{ step }`
 * - `onboarding:step-skipped` → `{ step }`
 * - `onboarding:dismissed` → `{ currentStep, completedSteps, skippedSteps }`
 * - `onboarding:completed` → `{ completedSteps, skippedSteps }`
 * - `onboarding:finished` → `{}`
 * - `onboarding:first-task-created` → `{ taskId? }`
 * - `onboarding:open-new-task` → `{}`
 * - `onboarding:open-github-import` → `{}`
 * - `onboarding:resumed` → `{ source, resumedFromStep? }`
 * - `onboarding:auto-triggered` → `{ trigger }`
 */
export function trackOnboardingEvent(type: string, metadata: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;

  try {
    const events = readOnboardingEventsFromStorage();
    const step = extractStep(metadata.step);
    const event: OnboardingEvent = {
      type,
      timestamp: new Date().toISOString(),
      ...(step ? { step } : {}),
      metadata,
      sessionId: getOnboardingSessionId(),
    };

    const nextEvents = pruneOnboardingEvents([...events, event]);
    writeOnboardingEventsToStorage(nextEvents);

    if (import.meta.env?.DEV) {
      console.info("[fusion:onboarding]", JSON.stringify(event));
    }
  } catch {
    // Quota/malformed-storage/runtime errors should never break onboarding UX.
  }
}

/**
 * Returns all persisted onboarding events for the current browser profile.
 * Returns an empty array in SSR/node contexts.
 */
export function getOnboardingEvents(): OnboardingEvent[] {
  if (typeof window === "undefined") return [];
  return readOnboardingEventsFromStorage();
}

/**
 * Clears all persisted onboarding events.
 */
export function clearOnboardingEvents(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(ONBOARDING_EVENTS_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

/**
 * Returns the onboarding session ID for this browser tab.
 *
 * The session ID is persisted in sessionStorage, so it survives navigation
 * reloads but resets across separate tabs/sessions.
 */
export function getOnboardingSessionId(): string {
  if (typeof window === "undefined") {
    return "server-session";
  }

  try {
    const existingId = sessionStorage.getItem(ONBOARDING_SESSION_ID_STORAGE_KEY);
    if (existingId) {
      return existingId;
    }

    const sessionId = createSessionId();
    sessionStorage.setItem(ONBOARDING_SESSION_ID_STORAGE_KEY, sessionId);
    return sessionId;
  } catch {
    return createSessionId();
  }
}

/**
 * Test-only helper to reset the cached onboarding session id in sessionStorage.
 */
export function __test_clearSessionId(): void {
  if (typeof window === "undefined") return;

  try {
    sessionStorage.removeItem(ONBOARDING_SESSION_ID_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `onboarding-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readOnboardingEventsFromStorage(): OnboardingEvent[] {
  try {
    const raw = localStorage.getItem(ONBOARDING_EVENTS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isOnboardingEvent);
  } catch {
    return [];
  }
}

function writeOnboardingEventsToStorage(events: OnboardingEvent[]): void {
  try {
    localStorage.setItem(ONBOARDING_EVENTS_STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Ignore storage write errors (quota/private mode/etc).
  }
}

/**
 * Applies ring-buffer bounds, pruning oldest events in batches for fewer writes.
 */
function pruneOnboardingEvents(events: OnboardingEvent[]): OnboardingEvent[] {
  const nextEvents = [...events];

  while (nextEvents.length > ONBOARDING_EVENTS_MAX) {
    nextEvents.splice(0, ONBOARDING_EVENTS_PRUNE_BATCH);
  }

  return nextEvents;
}

function extractStep(value: unknown): OnboardingStep | undefined {
  if (
    value === "ai-setup"
    || value === "github"
    || value === "first-task"
    || value === "complete"
  ) {
    return value;
  }

  return undefined;
}

function isOnboardingEvent(value: unknown): value is OnboardingEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<OnboardingEvent>;
  return (
    typeof candidate.type === "string"
    && typeof candidate.timestamp === "string"
    && typeof candidate.sessionId === "string"
    && !!candidate.metadata
    && typeof candidate.metadata === "object"
  );
}
