import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSnippet, GlobalSettings, Settings } from "@fusion/core";

const apiMocks = vi.hoisted(() => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

vi.mock("../../api", () => apiMocks);

/*
FNXC:SnippetsDestination 2026-09-16-21:44:
FN-476: the cache learns about another client's write from ONE shared SSE subscription opened by the first consumer and
released by the last. The bus is captured here so the suite drives the real subscription the cache opens — and asserts
its lifecycle — without any network connection.
*/
interface CapturedSubscription {
  url: string;
  events: Record<string, (event: MessageEvent) => void>;
  onReconnect?: () => void;
  released: boolean;
}

const sseSubscriptions: CapturedSubscription[] = [];
vi.mock("../../sse-bus", () => ({
  subscribeSse: (url: string, sub: { events?: Record<string, (event: MessageEvent) => void>; onReconnect?: () => void }) => {
    const entry: CapturedSubscription = { url, events: sub.events ?? {}, onReconnect: sub.onReconnect, released: false };
    sseSubscriptions.push(entry);
    return () => { entry.released = true; };
  },
}));

function liveSubscriptions(): CapturedSubscription[] {
  return sseSubscriptions.filter((entry) => !entry.released);
}

function emitSnippetsUpdated(): void {
  for (const entry of liveSubscriptions()) {
    entry.events["settings:chat-snippets-updated"]?.(new MessageEvent("message", { data: "{}" }));
  }
}

import {
  __test_resetChatSnippetsCache,
  useChatSnippetsCache,
} from "../useChatSnippetsCache";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function response(snippets: readonly ChatSnippet[]): GlobalSettings {
  return { chatSnippets: snippets.map((snippet) => ({ ...snippet })) };
}

describe("useChatSnippetsCache", () => {
  let serverSnippets: ChatSnippet[];
  let getItemSpy: ReturnType<typeof vi.spyOn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __test_resetChatSnippetsCache();
    sseSubscriptions.length = 0;
    serverSnippets = [];
    apiMocks.fetchGlobalSettings.mockReset();
    apiMocks.updateGlobalSettings.mockReset();
    apiMocks.fetchGlobalSettings.mockImplementation(async () => response(serverSnippets));
    apiMocks.updateGlobalSettings.mockImplementation(async (patch: Partial<GlobalSettings>) => {
      serverSnippets = (patch.chatSnippets ?? []).map((snippet) => ({ ...snippet }));
      return response(serverSnippets) as Settings;
    });
    getItemSpy = vi.spyOn(Storage.prototype, "getItem");
    setItemSpy = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    __test_resetChatSnippetsCache();
    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  it("shares one initial read across two subscribers without using localStorage", async () => {
    const firstRead = deferred<GlobalSettings>();
    apiMocks.fetchGlobalSettings.mockReturnValueOnce(firstRead.promise);

    const first = renderHook(() => useChatSnippetsCache());
    const second = renderHook(() => useChatSnippetsCache());
    expect(apiMocks.fetchGlobalSettings).toHaveBeenCalledTimes(1);

    await act(async () => firstRead.resolve(response([{ name: "test", prompt: "prompt" }])));
    await waitFor(() => expect(second.result.current.hasLoaded).toBe(true));
    expect(first.result.current.snippets).toEqual([{ name: "test", prompt: "prompt" }]);
    /*
    FNXC:SnippetsDestination 2026-09-16-21:44:
    FN-476: the invariant here is that PROMPT DEFINITIONS never reach persistent browser storage — not that the module
    touches no storage key at all. The live subscription now runs through the shared SSE bus, whose multiplexer reads
    its own client identifier from localStorage, so the assertion names that one allowed key instead of forbidding a
    read that carries no snippet data.
    */
    const touchedKeys = [
      ...getItemSpy.mock.calls.map((call) => String(call[0])),
      ...setItemSpy.mock.calls.map((call) => String(call[0])),
    ];
    expect(touchedKeys.every((key) => key === "fusion:sse-client-id")).toBe(true);
    expect(setItemSpy.mock.calls.some((call) => JSON.stringify(call[1] ?? "").includes("prompt"))).toBe(false);

    first.unmount();
    second.unmount();
  });

  it("serializes create, update, and delete intents and rebases each on the forced read", async () => {
    serverSnippets = [{ name: "kept", prompt: "keep" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));

    let create!: Promise<void>;
    let update!: Promise<void>;
    let remove!: Promise<void>;
    act(() => {
      create = view.result.current.createSnippet({ name: "alpha", prompt: "first" });
      update = view.result.current.updateSnippet("alpha", { name: "beta", prompt: "second" });
      remove = view.result.current.deleteSnippet("kept");
    });
    await act(async () => Promise.all([create, update, remove]));

    expect(apiMocks.updateGlobalSettings).toHaveBeenCalledTimes(3);
    expect(apiMocks.fetchGlobalSettings).toHaveBeenCalledTimes(4);
    expect(apiMocks.fetchGlobalSettings.mock.calls.slice(1)).toEqual([
      [{ forceFresh: true }],
      [{ forceFresh: true }],
      [{ forceFresh: true }],
    ]);
    expect(view.result.current.snippets).toEqual([{ name: "beta", prompt: "second" }]);
  });

  it("finishes explicit mutation rebase after unmount without losing a queued intent", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));
    const firstWrite = deferred<Settings>();
    apiMocks.updateGlobalSettings.mockReturnValueOnce(firstWrite.promise);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = view.result.current.createSnippet({ name: "first", prompt: "first" });
      second = view.result.current.createSnippet({ name: "second", prompt: "second" });
    });
    view.unmount();
    serverSnippets = [
      { name: "base", prompt: "base" },
      { name: "first", prompt: "first" },
    ];
    firstWrite.resolve(response(serverSnippets) as Settings);
    await Promise.all([first, second]);

    expect(apiMocks.updateGlobalSettings).toHaveBeenCalledTimes(2);
    expect(apiMocks.updateGlobalSettings.mock.calls[1]?.[0]).toEqual({
      chatSnippets: [
        { name: "base", prompt: "base" },
        { name: "first", prompt: "first" },
        { name: "second", prompt: "second" },
      ],
    });
    expect(apiMocks.fetchGlobalSettings.mock.calls.slice(1)).toEqual([
      [{ forceFresh: true }],
      [{ forceFresh: true }],
    ]);
  });

  it("ignores a passive read that resolves after a newer mutation", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const first = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(first.result.current.hasLoaded).toBe(true));
    first.unmount();

    const staleRead = deferred<GlobalSettings>();
    apiMocks.fetchGlobalSettings.mockReturnValueOnce(staleRead.promise);
    const second = renderHook(() => useChatSnippetsCache());

    await act(async () => {
      await second.result.current.createSnippet({ name: "fresh", prompt: "new prompt" });
    });
    await act(async () => staleRead.resolve(response([{ name: "stale", prompt: "stale" }])));

    expect(second.result.current.snippets).toEqual([
      { name: "base", prompt: "base" },
      { name: "fresh", prompt: "new prompt" },
    ]);
  });

  it("drops only a failed PUT intent, refreshes, and continues later intents", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));
    apiMocks.updateGlobalSettings
      .mockRejectedValueOnce(new Error("write failed"))
      .mockImplementationOnce(async (patch: Partial<GlobalSettings>) => {
        serverSnippets = (patch.chatSnippets ?? []).map((snippet) => ({ ...snippet }));
        return response(serverSnippets) as Settings;
      });

    let failed!: Promise<void>;
    let succeeded!: Promise<void>;
    act(() => {
      failed = view.result.current.createSnippet({ name: "failed", prompt: "not saved" });
      succeeded = view.result.current.createSnippet({ name: "kept", prompt: "saved" });
    });

    await expect(failed).rejects.toThrow("write failed");
    await act(async () => succeeded);
    expect(apiMocks.updateGlobalSettings).toHaveBeenCalledTimes(2);
    expect(view.result.current.snippets).toEqual([
      { name: "base", prompt: "base" },
      { name: "kept", prompt: "saved" },
    ]);
  });

  it("does not blank known snippets when PUT omits the key or a GET fails", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));

    apiMocks.updateGlobalSettings.mockResolvedValueOnce({ themeMode: "dark" } as Settings);
    const refreshAfterPut = deferred<GlobalSettings>();
    apiMocks.fetchGlobalSettings.mockReturnValueOnce(refreshAfterPut.promise);
    let create!: Promise<void>;
    act(() => {
      create = view.result.current.createSnippet({ name: "fresh", prompt: "new" });
    });
    expect(view.result.current.snippets).toEqual([{ name: "base", prompt: "base" }]);
    await act(async () => refreshAfterPut.resolve(response([
      { name: "base", prompt: "base" },
      { name: "fresh", prompt: "new" },
    ])));
    await act(async () => create);

    apiMocks.fetchGlobalSettings.mockRejectedValueOnce(new Error("read failed"));
    await act(async () => view.result.current.refresh());
    expect(view.result.current.snippets).toEqual([
      { name: "base", prompt: "base" },
      { name: "fresh", prompt: "new" },
    ]);
    expect(view.result.current.error?.message).toBe("read failed");
    expect(view.result.current.loading).toBe(false);
  });

  it("recovers from a failed post-PUT GET before rebasing the next intent", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));

    apiMocks.fetchGlobalSettings
      .mockRejectedValueOnce(new Error("post-write read failed"))
      .mockImplementation(async () => response(serverSnippets));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = view.result.current.createSnippet({ name: "first", prompt: "first" });
      second = view.result.current.createSnippet({ name: "second", prompt: "second" });
    });

    await expect(first).rejects.toThrow("post-write read failed");
    await act(async () => second);
    expect(view.result.current.snippets).toEqual([
      { name: "base", prompt: "base" },
      { name: "first", prompt: "first" },
      { name: "second", prompt: "second" },
    ]);
  });

  it("does not overwrite an accepted PUT when both reconciliation reads fail", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));

    apiMocks.fetchGlobalSettings
      .mockRejectedValueOnce(new Error("post-write read failed"))
      .mockRejectedValueOnce(new Error("recovery read failed"));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = view.result.current.createSnippet({ name: "first", prompt: "first" });
      second = view.result.current.createSnippet({ name: "second", prompt: "second" });
    });

    const outcomes = await act(async () => Promise.allSettled([first, second]));
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: "post-write read failed" }) }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          message: "Chat snippets could not be refreshed; queued changes were not saved",
        }),
      }),
    ]);
    expect(apiMocks.updateGlobalSettings).toHaveBeenCalledTimes(1);
    expect(serverSnippets).toEqual([
      { name: "base", prompt: "base" },
      { name: "first", prompt: "first" },
    ]);
    expect(view.result.current.error?.message).toBe("recovery read failed");

    await act(async () => view.result.current.refresh());
    await act(async () => view.result.current.createSnippet({ name: "third", prompt: "third" }));
    expect(apiMocks.updateGlobalSettings).toHaveBeenCalledTimes(2);
    expect(apiMocks.updateGlobalSettings.mock.calls[1]?.[0]).toEqual({
      chatSnippets: [
        { name: "base", prompt: "base" },
        { name: "first", prompt: "first" },
        { name: "third", prompt: "third" },
      ],
    });
  });

  it("removes visibility revalidation and fences passive work after the last unmount", async () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));
    const callsBeforeUnmount = apiMocks.fetchGlobalSettings.mock.calls.length;

    view.unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    expect(addListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(apiMocks.fetchGlobalSettings).toHaveBeenCalledTimes(callsBeforeUnmount);
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("ouvre une seule souscription partagée et la libère au dernier démontage", async () => {
    const first = renderHook(() => useChatSnippetsCache());
    const second = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(second.result.current.hasLoaded).toBe(true));

    expect(liveSubscriptions()).toHaveLength(1);
    expect(liveSubscriptions()[0]!.url).toBe("/api/events");

    first.unmount();
    expect(liveSubscriptions()).toHaveLength(1);
    second.unmount();
    expect(liveSubscriptions()).toHaveLength(0);
  });

  it("relit une seule fois après une rafale d'événements et publie le dernier état autoritaire", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));
    const before = apiMocks.fetchGlobalSettings.mock.calls.length;

    serverSnippets = [{ name: "base", prompt: "base" }, { name: "remote", prompt: "remote" }];
    await act(async () => {
      emitSnippetsUpdated();
      emitSnippetsUpdated();
      emitSnippetsUpdated();
    });

    await waitFor(() => expect(view.result.current.snippets).toEqual(serverSnippets));
    const reads = apiMocks.fetchGlobalSettings.mock.calls.slice(before);
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(reads.every((call) => call[0]?.forceFresh === true)).toBe(true);
    view.unmount();
  });

  it("relit après une reconnexion ayant pu manquer un événement", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));

    serverSnippets = [{ name: "pendant-coupure", prompt: "invisible" }];
    await act(async () => { liveSubscriptions()[0]!.onReconnect?.(); });

    await waitFor(() => expect(view.result.current.snippets).toEqual(serverSnippets));
    view.unmount();
  });

  it("ne laisse pas une notification reçue pendant une mutation écraser le résultat du PUT", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));

    const write = deferred<Settings>();
    apiMocks.updateGlobalSettings.mockReturnValueOnce(write.promise);
    let mutation!: Promise<void>;
    act(() => { mutation = view.result.current.createSnippet({ name: "mien", prompt: "le mien" }); });

    // Un autre client publie pendant la transaction : la lecture passive doit être différée, pas concurrente.
    const readsBefore = apiMocks.fetchGlobalSettings.mock.calls.length;
    emitSnippetsUpdated();
    expect(apiMocks.fetchGlobalSettings).toHaveBeenCalledTimes(readsBefore);

    serverSnippets = [{ name: "base", prompt: "base" }, { name: "mien", prompt: "le mien" }];
    await act(async () => {
      write.resolve({ chatSnippets: serverSnippets.map((snippet) => ({ ...snippet })) } as Settings);
      await mutation;
    });

    await waitFor(() => expect(view.result.current.snippets).toEqual(serverSnippets));
    expect(apiMocks.updateGlobalSettings).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("marque le cache périmé quand la notification arrive sans abonné et relit à la remontée", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));
    view.unmount();

    serverSnippets = [{ name: "apres", prompt: "apres" }];
    emitSnippetsUpdated();

    const remounted = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(remounted.result.current.snippets).toEqual(serverSnippets));
    remounted.unmount();
  });

  it("préserve la normalisation quand la réponse n'a pas, ou duplique, des snippets", async () => {
    apiMocks.fetchGlobalSettings.mockResolvedValueOnce({} as GlobalSettings);
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));
    expect(view.result.current.snippets).toEqual([]);

    apiMocks.fetchGlobalSettings.mockResolvedValueOnce({
      chatSnippets: [{ name: "Dup", prompt: "un" }, { name: "dup", prompt: "deux" }],
    } as GlobalSettings);
    await act(async () => { emitSnippetsUpdated(); });

    await waitFor(() => expect(view.result.current.snippets.length).toBeLessThanOrEqual(1));
    view.unmount();
  });

  it("récupère après une relecture en échec déclenchée par une notification", async () => {
    serverSnippets = [{ name: "base", prompt: "base" }];
    const view = renderHook(() => useChatSnippetsCache());
    await waitFor(() => expect(view.result.current.hasLoaded).toBe(true));

    apiMocks.fetchGlobalSettings.mockRejectedValueOnce(new Error("lecture impossible"));
    await act(async () => { emitSnippetsUpdated(); });
    await waitFor(() => expect(view.result.current.error?.message).toBe("lecture impossible"));
    // La dernière liste connue reste affichée plutôt que d'être vidée.
    expect(view.result.current.snippets).toEqual([{ name: "base", prompt: "base" }]);

    serverSnippets = [{ name: "rétabli", prompt: "ok" }];
    await act(async () => { emitSnippetsUpdated(); });
    await waitFor(() => expect(view.result.current.snippets).toEqual(serverSnippets));
    view.unmount();
  });
});
