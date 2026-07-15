import { AgentStore, ChatStore, type MessageStore, type TaskStore } from "@fusion/core";
import type { ProjectEngineManager } from "@fusion/engine";
import { ChatManager } from "./chat.js";
import { requireAsyncLayer } from "./require-async-layer.js";

const scopedChatStoreCache = new Map<string, ChatStore>();

function cacheKeyForStore(store: TaskStore): string {
  return store.getFusionDir();
}

export function getOrCreateScopedChatStore(store: TaskStore, fallbackChatStore?: ChatStore): ChatStore {
  const key = cacheKeyForStore(store);
  if (fallbackChatStore) {
    scopedChatStoreCache.set(key, fallbackChatStore);
    return fallbackChatStore;
  }

  const cached = scopedChatStoreCache.get(key);
  if (cached) return cached;

  /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Project-scoped chat stores require the authoritative PostgreSQL layer; missing wiring must not create SQLite state. */
  const layer = requireAsyncLayer(store, "Scoped ChatStore");
  const chatStore = new ChatStore(layer);
  scopedChatStoreCache.set(key, chatStore);
  return chatStore;
}

export async function resolveProjectChatContext(options: {
  projectId?: string | null;
  defaultStore: TaskStore;
  defaultChatStore?: ChatStore;
  engineManager?: ProjectEngineManager;
}): Promise<{ store: TaskStore; chatStore: ChatStore }> {
  const { projectId, defaultStore, defaultChatStore, engineManager } = options;
  if (!projectId) {
    return {
      store: defaultStore,
      chatStore: getOrCreateScopedChatStore(defaultStore, defaultChatStore),
    };
  }

  // Only use engine path when an engine is actually found for this project.
  if (engineManager) {
    const engine = engineManager.getEngine(projectId);
    if (engine) {
      try {
        const scopedStore = engine.getTaskStore?.() ?? defaultStore;
        const engineChatStore = engine.getChatStore?.();
        return {
          store: scopedStore,
          chatStore: getOrCreateScopedChatStore(scopedStore, engineChatStore),
        };
      } catch {
        // engine's store not accessible — fall through to default
      }
    }
  }

  // No engine for this project — use the default store.
  // Route handlers apply projectId filtering at the query level.
  return {
    store: defaultStore,
    chatStore: getOrCreateScopedChatStore(defaultStore, defaultChatStore),
  };
}

export async function createProjectScopedChatManager(options: {
  store: TaskStore;
  chatStore: ChatStore;
  pluginRunner?: ConstructorParameters<typeof ChatManager>[3];
  messageStore?: MessageStore;
}): Promise<ChatManager> {
  const agentStore = new AgentStore({ rootDir: options.store.getFusionDir(), asyncLayer: options.store.getAsyncLayer() ?? undefined });
  return new ChatManager(
    options.chatStore,
    options.store.getRootDir(),
    agentStore,
    options.pluginRunner,
    () => options.store.getSettings(),
    options.messageStore,
    options.store,
  );
}

export function __resetScopedChatStoreCache(): void {
  scopedChatStoreCache.clear();
}

const scopedChatManagerCache = new Map<string, ChatManager>();

export function getOrCreateScopedChatManager(
  store: TaskStore,
  chatStore: ChatStore,
  pluginRunner?: ConstructorParameters<typeof ChatManager>[3],
  refreshPluginRunner = false,
  messageStore?: MessageStore,
): ChatManager {
  const key = store.getFusionDir();
  const cached = scopedChatManagerCache.get(key);
  if (cached) {
    if (refreshPluginRunner && pluginRunner) {
      cached.setPluginRunner(pluginRunner);
    }
    if (messageStore) {
      cached.setMessageStore(messageStore);
    }
    return cached;
  }
  // FNXC:PostgresCutover 2026-07-05-20:10: keep the backend AsyncDataLayer on
  // the chat AgentStore (merge union with main's Hermes plugin-runner refresh).
  const agentStore = new AgentStore({ rootDir: store.getFusionDir(), asyncLayer: store.getAsyncLayer() ?? undefined });
  /*
   * FNXC:ProjectChatRuntime 2026-07-12-11:00:
   * Project/agent chat must expose the same tool schema over desktop and browser transports. The scoped manager is cached by fusion dir, so lazy engine boot must upgrade the cached MessageStore instead of leaving fn_send_message/fn_read_messages stale-missing after the first pre-engine resolution.
   */
  const manager = new ChatManager(
    chatStore,
    store.getRootDir(),
    agentStore,
    pluginRunner,
    () => store.getSettings(),
    messageStore,
    store,
  );
  scopedChatManagerCache.set(key, manager);
  return manager;
}

export function __resetScopedChatManagerCache(): void {
  scopedChatManagerCache.clear();
}
