import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetScopedChatManagerCache,
  getOrCreateScopedChatManager,
} from "../chat-project-services.js";

function createStore(fusionDir = "/tmp/fusion-project") {
  return {
    getFusionDir: vi.fn(() => fusionDir),
    getRootDir: vi.fn(() => "/tmp/project"),
    getSettings: vi.fn(async () => ({})),
    getDatabase: vi.fn(() => ({})),
    // FNXC:PostgresCutover 2026-07-16-06:30: dashboard service doubles must
    // expose the AsyncDataLayer contract used by AgentStore after SQLite removal.
    getAsyncLayer: vi.fn(() => ({})),
  } as any;
}

function createChatStore() {
  return {} as any;
}

describe("project-scoped ChatManager cache", () => {
  beforeEach(() => {
    __resetScopedChatManagerCache();
  });

  it("passes the engine MessageStore into a newly constructed scoped manager", () => {
    const store = createStore();
    const chatStore = createChatStore();
    const pluginRunner = { getRuntimeById: vi.fn() };
    const messageStore = { sendMessage: vi.fn(), getInbox: vi.fn() };

    const manager = getOrCreateScopedChatManager(store, chatStore, pluginRunner as any, true, messageStore as any);

    expect((manager as any).messageStore).toBe(messageStore);
  });

  it("upgrades a cached manager when the engine boots after first resolution", () => {
    const store = createStore();
    const chatStore = createChatStore();
    const initialPluginRunner = { getRuntimeById: vi.fn(() => undefined) };
    const enginePluginRunner = { getRuntimeById: vi.fn(() => ({ id: "runtime" })) };
    const messageStore = { sendMessage: vi.fn(), getInbox: vi.fn() };

    const preBootManager = getOrCreateScopedChatManager(store, chatStore, initialPluginRunner as any, false, undefined);
    expect((preBootManager as any).messageStore).toBeUndefined();

    const upgradedManager = getOrCreateScopedChatManager(store, chatStore, enginePluginRunner as any, true, messageStore as any);

    expect(upgradedManager).toBe(preBootManager);
    expect((upgradedManager as any).pluginRunner).toBe(enginePluginRunner);
    expect((upgradedManager as any).messageStore).toBe(messageStore);
  });

  it("preserves plugin-runner refresh semantics alongside MessageStore refresh", () => {
    const store = createStore();
    const chatStore = createChatStore();
    const fallbackPluginRunner = { getRuntimeById: vi.fn(() => undefined) };
    const enginePluginRunner = { getRuntimeById: vi.fn(() => ({ id: "runtime" })) };
    const messageStore = { sendMessage: vi.fn(), getInbox: vi.fn() };

    const manager = getOrCreateScopedChatManager(store, chatStore, fallbackPluginRunner as any, false, undefined);
    const cached = getOrCreateScopedChatManager(store, chatStore, enginePluginRunner as any, true, messageStore as any);

    expect(cached).toBe(manager);
    expect((cached as any).pluginRunner).toBe(enginePluginRunner);
    expect((cached as any).messageStore).toBe(messageStore);
  });
});
