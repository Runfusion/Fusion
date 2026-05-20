/**
 * Lightweight stale-while-revalidate cache helpers for dashboard reload hydration.
 *
 * Board task hydration uses a dedicated soft bound (`SWR_TASKS_MAX_AGE_MS`) so reloads do not present obviously stale task snapshots.
 * Chat messages and chat agents maps reuse that short TTL for fast-moving thread state, while models and discovered skills use the default 10-minute window for effectively session-static hydration.
 * Failed task revalidation clears the per-project tasks envelope to avoid re-hydrating stale data on the next reload.
 *
 * Invalidation contract:
 * - Per-project task entries use `SWR_CACHE_KEYS.TASKS_PREFIX + projectId`.
 * - Version updates clear TASKS_PREFIX plus PROJECTS and CURRENT_PROJECT_ID.
 */
export const SWR_CACHE_KEYS = {
  PROJECTS: "kb-dashboard-projects-cache",
  CURRENT_PROJECT_ID: "kb-dashboard-current-project-cache",
  TASKS_PREFIX: "kb-dashboard-tasks-cache:",
  AGENTS: "kb-dashboard-agents-cache",
  AGENT_STATS: "kb-dashboard-agent-stats-cache",
  DOCUMENTS_PREFIX: "kb-dashboard-documents-cache:",
  TODO_LISTS_PREFIX: "kb-dashboard-todo-lists-cache:",
  CHAT_ROOMS: "kb-dashboard-chat-rooms-cache",
  CHAT_SESSIONS_PREFIX: "kb-dashboard-chat-sessions-cache:",
  CHAT_MESSAGES_PREFIX: "kb-dashboard-chat-messages-cache:",
  CHAT_AGENTS_MAP_PREFIX: "kb-dashboard-chat-agents-map-cache:",
  MODELS: "kb-dashboard-models-cache",
  DISCOVERED_SKILLS_PREFIX: "kb-dashboard-discovered-skills-cache:",
  ACTIVE_CHAT_ROOM_ID: "kb-dashboard-active-chat-room-cache",
  INSIGHTS_PREFIX: "kb-dashboard-insights-cache:",
  INSIGHT_LATEST_RUN_PREFIX: "kb-dashboard-insight-latest-run-cache:",
  RESEARCH_RUNS_PREFIX: "kb-dashboard-research-runs-cache:",
  RESEARCH_SELECTED_ID_PREFIX: "kb-dashboard-research-selected-cache:",
  EVALS_RUNS_PREFIX: "kb-dashboard-evals-runs-cache:",
  EVALS_RESULTS_PREFIX: "kb-dashboard-evals-results-cache:",
  MISSIONS_PREFIX: "kb-dashboard-missions-cache:",
  MISSIONS_SELECTED_ID_PREFIX: "kb-dashboard-mission-selected-cache:",
  MAILBOX_INBOX_PREFIX: "kb-dashboard-mailbox-inbox-cache:",
  MAILBOX_OUTBOX_PREFIX: "kb-dashboard-mailbox-outbox-cache:",
  MAILBOX_UNREAD_COUNT_PREFIX: "kb-dashboard-mailbox-unread-cache:",
} as const;

const DEFAULT_MAX_BYTES = 500_000;

interface CacheEnvelope<T> {
  savedAt: number;
  data: T;
}

// Shared default for non-live dashboard hydration paths.
export const SWR_DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
// Board hydration soft bound: keep stale tasks visible briefly while forcing immediate revalidation.
export const SWR_TASKS_MAX_AGE_MS = 60_000;
export const SWR_LONG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getLocalStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return null;
}

export function readCache<T>(key: string, options?: { maxAgeMs?: number }): T | null {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(key);
    if (raw === null) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return parsed as T;
    }

    const hasEnvelopeMarkers = "savedAt" in parsed || "data" in parsed;
    if (!hasEnvelopeMarkers) {
      return parsed as T;
    }

    const envelope = parsed as Partial<CacheEnvelope<T>>;
    if (typeof envelope.savedAt !== "number" || Number.isNaN(envelope.savedAt)) {
      return envelope.data ?? null;
    }

    const maxAgeMs = options?.maxAgeMs;
    if (typeof maxAgeMs === "number") {
      const ageMs = Date.now() - envelope.savedAt;
      if (ageMs > maxAgeMs) {
        return null;
      }
    }

    return envelope.data ?? null;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, value: T, options?: { maxBytes?: number }): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    const serialized = JSON.stringify({
      savedAt: Date.now(),
      data: value,
    } satisfies CacheEnvelope<T>);
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    if (new TextEncoder().encode(serialized).length > maxBytes) {
      return;
    }

    storage.setItem(key, serialized);
  } catch {
    // Ignore quota and storage errors.
  }
}

export function clearCache(prefix: string): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    const keys = new Set<string>();

    for (const key in storage) {
      if (Object.prototype.hasOwnProperty.call(storage, key) && key.startsWith(prefix)) {
        keys.add(key);
      }
    }

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(prefix)) {
        keys.add(key);
      }
    }

    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // Ignore storage errors.
  }
}
