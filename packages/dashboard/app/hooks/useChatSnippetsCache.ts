import { useCallback, useSyncExternalStore } from "react";
import {
  CHAT_SNIPPET_MAX_ENTRIES,
  normalizeChatSnippetName,
  normalizeChatSnippets,
  readChatSnippets,
  type ChatSnippet,
  type GlobalSettings,
} from "@fusion/core";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";
import { subscribeSse } from "../sse-bus";

export interface UseChatSnippetsCacheResult {
  snippets: ChatSnippet[];
  loading: boolean;
  error: Error | null;
  hasLoaded: boolean;
  createSnippet: (snippet: ChatSnippet) => Promise<void>;
  updateSnippet: (currentName: string, snippet: ChatSnippet) => Promise<void>;
  deleteSnippet: (name: string) => Promise<void>;
  refresh: () => Promise<void>;
}

type ChatSnippetIntent =
  | { kind: "create"; snippet: ChatSnippet }
  | { kind: "update"; currentName: string; snippet: ChatSnippet }
  | { kind: "delete"; name: string };

interface PendingIntent {
  intent: ChatSnippetIntent;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ChatSnippetsCacheSnapshot {
  snippets: ChatSnippet[];
  loading: boolean;
  error: Error | null;
  hasLoaded: boolean;
}

const EMPTY_SNAPSHOT: ChatSnippetsCacheSnapshot = {
  snippets: [],
  loading: false,
  error: null,
  hasLoaded: false,
};

let snapshot = EMPTY_SNAPSHOT;
let authoritativeSnippets: ChatSnippet[] | null = null;
let epoch = 0;
let passiveRequest: Promise<void> | null = null;
let needsRefresh = true;
let processingQueue = false;
let visibilityListening = false;
/*
FNXC:SnippetsDestination 2026-09-16-21:44:
FN-476: Snippets is a destination with no manual refresh, so the cache learns about another client's write from one
shared `/api/events` subscription opened by the FIRST consumer and closed by the LAST — never one connection per
composer. `snippetsUnsubscribe` is that single handle. `deferredInvalidation` holds a notification that arrived while an
explicit mutation was in flight: re-reading mid-FIFO could let a passive response overwrite an accepted PUT, so the
re-read is deferred until the queue drains. Repeated events coalesce into one authoritative read.
*/
let snippetsUnsubscribe: (() => void) | null = null;
let deferredInvalidation = false;
let pendingRemoteRead = false;
const listeners = new Set<() => void>();
const intentQueue: PendingIntent[] = [];

const SNIPPETS_UPDATED_SSE_EVENT = "settings:chat-snippets-updated";

function cloneSnippets(snippets: readonly ChatSnippet[]): ChatSnippet[] {
  return snippets.map(({ name, prompt }) => ({ name, prompt }));
}

function publish(patch: Partial<ChatSnippetsCacheSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function adoptAuthoritative(settings: { chatSnippets?: unknown }): void {
  authoritativeSnippets = readChatSnippets(settings);
  needsRefresh = false;
  publish({
    snippets: cloneSnippets(authoritativeSnippets),
    hasLoaded: true,
    loading: false,
    error: null,
  });
}

async function fetchPassive(forceFresh = false): Promise<void> {
  if (passiveRequest) return passiveRequest;
  const requestEpoch = epoch;
  publish({ loading: true });
  const request = (async () => {
    try {
      const settings = await fetchGlobalSettings(forceFresh ? { forceFresh: true } : undefined);
      if (requestEpoch !== epoch || listeners.size === 0) return;
      adoptAuthoritative(settings);
    } catch (error) {
      if (requestEpoch !== epoch || listeners.size === 0) return;
      publish({
        loading: false,
        error: toError(error, "Failed to load chat snippets"),
      });
    } finally {
      if (requestEpoch === epoch) passiveRequest = null;
      if (requestEpoch === epoch && listeners.size > 0 && snapshot.loading) {
        publish({ loading: false });
      }
    }
  })();
  passiveRequest = request;
  return request;
}

async function forceAuthoritativeRead(): Promise<void> {
  /*
  FNXC:ChatSnippets 2026-09-03-16:48:
  A forced read belongs to an explicit mutation transaction, not passive background revalidation. Let it finish after unmount so subsequent queued intents still rebase on server truth; only visibility/initial passive reads are subscriber-fenced.
  */
  const settings = await fetchGlobalSettings({ forceFresh: true });
  adoptAuthoritative(settings);
}

function assertNormalizedSnippet(snippet: ChatSnippet): ChatSnippet {
  const normalized = normalizeChatSnippets([snippet]);
  if (normalized.length !== 1) {
    throw new Error("The chat snippet is invalid");
  }
  return normalized[0]!;
}

function applyIntent(base: readonly ChatSnippet[], intent: ChatSnippetIntent): ChatSnippet[] {
  const current = cloneSnippets(base);
  if (intent.kind === "create") {
    const snippet = assertNormalizedSnippet(intent.snippet);
    if (current.some((candidate) => candidate.name === snippet.name)) {
      throw new Error(`Chat snippet /${snippet.name} already exists`);
    }
    if (current.length >= CHAT_SNIPPET_MAX_ENTRIES) {
      throw new Error("The chat snippet limit has been reached");
    }
    return [...current, snippet];
  }

  const lookupName = normalizeChatSnippetName(intent.kind === "update" ? intent.currentName : intent.name);
  const index = lookupName ? current.findIndex((candidate) => candidate.name === lookupName) : -1;
  if (index < 0) {
    throw new Error("The chat snippet no longer exists");
  }

  if (intent.kind === "delete") {
    return current.filter((_, candidateIndex) => candidateIndex !== index);
  }

  const snippet = assertNormalizedSnippet(intent.snippet);
  if (current.some((candidate, candidateIndex) => candidateIndex !== index && candidate.name === snippet.name)) {
    throw new Error(`Chat snippet /${snippet.name} already exists`);
  }
  current[index] = snippet;
  return current;
}

async function recoverAfterMutationError(error: Error): Promise<boolean> {
  publish({ loading: false, error });
  try {
    await forceAuthoritativeRead();
    return true;
  } catch (refreshError) {
    /*
    FNXC:ChatSnippets 2026-09-03-16:59:
    A failed write reconciliation makes the prior authoritative snapshot unsafe for subsequent intents: the server may have accepted the write before its forced read failed. Fence that base and reject queued intents without another PUT until a later refresh restores server truth.
    */
    authoritativeSnippets = null;
    needsRefresh = true;
    publish({
      loading: false,
      error: toError(refreshError, "Failed to refresh chat snippets"),
    });
    return false;
  }
}

/*
FNXC:ChatSnippets 2026-09-03-15:56:
All mounted chat composers and SkillsView share one memory-only snapshot. Mutations are rebased and serialized through this FIFO, passive reads are epoch-fenced, and the final subscriber removes visibility revalidation so prompt definitions never leak into persistent browser caches or ownerless background work.
*/
async function processIntentQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;
  try {
    while (intentQueue.length > 0) {
      const pending = intentQueue[0]!;
      if (!snapshot.hasLoaded || authoritativeSnippets === null) {
        const error = new Error("Chat snippets must load before they can be changed");
        intentQueue.shift();
        pending.reject(error);
        publish({ error });
        continue;
      }

      let next: ChatSnippet[];
      try {
        next = applyIntent(authoritativeSnippets, pending.intent);
      } catch (error) {
        const intentError = toError(error, "The chat snippet change is no longer applicable");
        intentQueue.shift();
        pending.reject(intentError);
        publish({ error: intentError });
        continue;
      }

      epoch += 1;
      passiveRequest = null;
      try {
        const response = await updateGlobalSettings({ chatSnippets: next });
        if (Object.hasOwn(response, "chatSnippets")) {
          const provisional = readChatSnippets(response as GlobalSettings);
          publish({ snippets: cloneSnippets(provisional), error: null });
        }
        await forceAuthoritativeRead();
        intentQueue.shift();
        pending.resolve();
      } catch (error) {
        const mutationError = toError(error, "Failed to save chat snippets");
        intentQueue.shift();
        pending.reject(mutationError);
        const recovered = await recoverAfterMutationError(mutationError);
        if (!recovered) {
          const rebaseError = new Error(
            "Chat snippets could not be refreshed; queued changes were not saved",
          );
          for (const queued of intentQueue.splice(0)) {
            queued.reject(rebaseError);
          }
          break;
        }
      }
    }
  } finally {
    processingQueue = false;
    // A notification that landed mid-transaction becomes one authoritative re-read now that the queue is idle.
    flushDeferredInvalidation();
  }
}

function enqueueIntent(intent: ChatSnippetIntent): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    intentQueue.push({ intent, resolve, reject });
    void processIntentQueue();
  });
}

function handleVisibilityChange(): void {
  if (document.visibilityState !== "visible" || listeners.size === 0) return;
  epoch += 1;
  passiveRequest = null;
  void fetchPassive(true);
}

/**
 * FNXC:SnippetsDestination 2026-09-16-21:44:
 * Invalidates the shared snapshot after a remote write. The epoch bump fences any passive read already in flight so a
 * response captured before the change cannot publish over the fresh one. While the mutation FIFO is busy the
 * invalidation is only remembered: the queue's own forced authoritative read already ends on server truth, and reading
 * underneath it is exactly how a stale response overwrites an accepted mutation.
 */
function invalidateFromRemoteChange(): void {
  if (listeners.size === 0) {
    needsRefresh = true;
    return;
  }
  if (processingQueue || intentQueue.length > 0) {
    deferredInvalidation = true;
    return;
  }
  /*
  Coalescing: a burst of notifications (a peer saving several snippets, or a reconnect landing on top of an event) must
  not become a burst of GETs. While a read is already in flight the extra events collapse into ONE follow-up read,
  which is still required because the in-flight response was captured before the latest change.
  */
  if (passiveRequest) {
    pendingRemoteRead = true;
    return;
  }
  startRemoteRead();
}

function startRemoteRead(): void {
  deferredInvalidation = false;
  epoch += 1;
  passiveRequest = null;
  void fetchPassive(true).finally(() => {
    if (!pendingRemoteRead) return;
    pendingRemoteRead = false;
    if (listeners.size === 0) {
      needsRefresh = true;
      return;
    }
    startRemoteRead();
  });
}

function flushDeferredInvalidation(): void {
  if (!deferredInvalidation) return;
  if (listeners.size === 0) {
    deferredInvalidation = false;
    needsRefresh = true;
    return;
  }
  startRemoteRead();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (!visibilityListening) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
      visibilityListening = true;
    }
    if (!snippetsUnsubscribe) {
      /*
      Snippets are global, so the stream is the unscoped `/api/events` channel already multiplexed by the shared bus.
      `onReconnect` re-reads because an event emitted while the socket was down (or while the tab was suspended) is
      simply gone — the bus has no replay for it.
      */
      snippetsUnsubscribe = subscribeSse("/api/events", {
        events: { [SNIPPETS_UPDATED_SSE_EVENT]: () => invalidateFromRemoteChange() },
        onReconnect: () => invalidateFromRemoteChange(),
      });
    }
    if (needsRefresh || !snapshot.hasLoaded) {
      void fetchPassive();
    }
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (visibilityListening) {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      visibilityListening = false;
    }
    if (snippetsUnsubscribe) {
      snippetsUnsubscribe();
      snippetsUnsubscribe = null;
    }
    deferredInvalidation = false;
    pendingRemoteRead = false;
    epoch += 1;
    passiveRequest = null;
    needsRefresh = true;
    snapshot = { ...snapshot, loading: false };
  };
}

function getSnapshot(): ChatSnippetsCacheSnapshot {
  return snapshot;
}

export function useChatSnippetsCache(): UseChatSnippetsCacheResult {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const createSnippet = useCallback((snippet: ChatSnippet) => enqueueIntent({ kind: "create", snippet }), []);
  const updateSnippet = useCallback(
    (currentName: string, snippet: ChatSnippet) => enqueueIntent({ kind: "update", currentName, snippet }),
    [],
  );
  const deleteSnippet = useCallback((name: string) => enqueueIntent({ kind: "delete", name }), []);
  const refresh = useCallback(async () => {
    epoch += 1;
    passiveRequest = null;
    await fetchPassive(true);
  }, []);

  return {
    ...current,
    createSnippet,
    updateSnippet,
    deleteSnippet,
    refresh,
  };
}

/**
 * FNXC:ChatSnippets 2026-09-03-16:32:
 * Composer consumers subscribe only to the snippets array so cache loading/error transitions do not rerender transcript and scroll state. The management view uses the full snapshot because it owns those status surfaces.
 */
export function useChatSnippets(): ChatSnippet[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.snippets,
    () => snapshot.snippets,
  );
}

export function __test_resetChatSnippetsCache(): void {
  if (visibilityListening) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  snippetsUnsubscribe?.();
  snippetsUnsubscribe = null;
  deferredInvalidation = false;
  pendingRemoteRead = false;
  for (const pending of intentQueue.splice(0)) {
    pending.reject(new Error("Chat snippets cache reset"));
  }
  listeners.clear();
  snapshot = EMPTY_SNAPSHOT;
  authoritativeSnippets = null;
  epoch += 1;
  passiveRequest = null;
  needsRefresh = true;
  processingQueue = false;
  visibilityListening = false;
}
