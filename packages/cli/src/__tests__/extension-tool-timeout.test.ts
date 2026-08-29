import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __clearExtensionStoreBootStateForTesting,
  __getStoreForTesting,
  __peekCachedStoreForTesting,
  __setExtensionStoreBootFactoryForTesting,
  clampImportBrowseLimit,
  clearHostTaskStores,
  closeCachedStores,
  raceWithTimeoutAndAbort,
  resolveExtensionToolTimeoutMs,
  setHostTaskStore,
  wrapExtensionToolExecute,
} from "../extension.js";

/*
FNXC:MergeQueue 2026-07-15-11:15:
FN-7956 hung AI merge review on unbounded extension fn_task_show. These unit tests lock the fail-closed timeout/abort budgets that unblock agent turns when store work wedges.

FNXC:MergeQueue 2026-07-15-11:28:
Host extension research tools are off; budgets cover remaining long host tools only.
*/

afterEach(async () => {
  await closeCachedStores();
  __clearExtensionStoreBootStateForTesting();
  clearHostTaskStores();
  vi.restoreAllMocks();
});

describe("resolveExtensionToolTimeoutMs", () => {
  it("keeps the default 60s budget for ordinary store tools", () => {
    expect(resolveExtensionToolTimeoutMs("fn_task_show")).toBe(60_000);
    expect(resolveExtensionToolTimeoutMs("fn_task_list")).toBe(60_000);
  });

  it("gives multi-minute budgets to long host tools", () => {
    expect(resolveExtensionToolTimeoutMs("fn_skills_install")).toBe(300_000);
    expect(resolveExtensionToolTimeoutMs("fn_task_plan")).toBe(300_000);
    expect(resolveExtensionToolTimeoutMs("fn_experiment_finalize")).toBe(180_000);
    expect(resolveExtensionToolTimeoutMs("fn_mission_backfill_assertions")).toBe(180_000);
    expect(resolveExtensionToolTimeoutMs("fn_task_import_github")).toBe(180_000);
    expect(resolveExtensionToolTimeoutMs("fn_task_browse_github_issues")).toBe(180_000);
    expect(resolveExtensionToolTimeoutMs("fn_web_fetch")).toBe(90_000);
  });
});

describe("clampImportBrowseLimit", () => {
  it("defaults to 30 and hard-caps at 50", () => {
    expect(clampImportBrowseLimit(undefined)).toBe(30);
    expect(clampImportBrowseLimit(100)).toBe(50);
    expect(clampImportBrowseLimit(0)).toBe(1);
    expect(clampImportBrowseLimit(12)).toBe(12);
  });
});

describe("setHostTaskStore", () => {
  it("caches the host store so getStore reuses it without dual-boot", () => {
    /*
    FNXC:MergeQueue 2026-07-15-11:50:
    Host injection must place the store under resolveProjectRoot so tool getStore hits the external entry.
    */
    const fakeStore = { id: "host-store" } as unknown as import("@fusion/core").TaskStore;
    const root = "/tmp/fusion-host-store-test";
    setHostTaskStore(root, fakeStore);
    expect(__peekCachedStoreForTesting(root)).toBe(fakeStore);
    clearHostTaskStores(root);
    expect(__peekCachedStoreForTesting(root)).toBeUndefined();
  });
});

describe("extension TaskStore resolution", () => {
  const root = "/tmp/fusion-extension-store-resolution";

  const bootResult = (store: import("@fusion/core").TaskStore) => ({
    taskStore: store,
    shutdown: vi.fn(async () => {}),
  }) as Awaited<ReturnType<typeof import("@fusion/core").createTaskStoreForBackend>>;

  it("shares the host-injected store with a separately evaluated host extension", async () => {
    /*
    FNXC:ExtensionStoreRegistry 2026-07-16-15:20:
    Pi can evaluate the extension separately from the daemon's CLI import. This reproduces the FN-8140 no-host-cache symptom without starting embedded PostgreSQL: a separate copy must see the host store and never invoke its controllable wedged cold boot.
    */
    const hostStore = { id: "host-store" } as unknown as import("@fusion/core").TaskStore;
    setHostTaskStore(root, hostStore);

    vi.resetModules();
    const isolated = await import("../extension.js");
    const neverSettles = vi.fn(() => new Promise<never>(() => {}));
    isolated.__setExtensionStoreBootFactoryForTesting(neverSettles as typeof import("@fusion/core").createTaskStoreForBackend);

    await expect(isolated.__getStoreForTesting(root, 25)).resolves.toBe(hostStore);
    expect(neverSettles).not.toHaveBeenCalled();
  });

  it("boots a healthy cold cache once and coalesces concurrent callers", async () => {
    const store = { id: "cold-store" } as unknown as import("@fusion/core").TaskStore;
    let resolveBoot: ((value: Awaited<ReturnType<typeof import("@fusion/core").createTaskStoreForBackend>>) => void) | undefined;
    const factory = vi.fn(() => new Promise<Awaited<ReturnType<typeof import("@fusion/core").createTaskStoreForBackend>>>((resolve) => {
      resolveBoot = resolve;
    }));
    __setExtensionStoreBootFactoryForTesting(factory as typeof import("@fusion/core").createTaskStoreForBackend);

    const first = __getStoreForTesting(`${root}-cold`, 100);
    const second = __getStoreForTesting(`${root}-cold`, 100);
    expect(factory).toHaveBeenCalledOnce();
    resolveBoot!(bootResult(store));

    await expect(Promise.all([first, second])).resolves.toEqual([store, store]);
  });

  it("does not overwrite a host store injected while a cold boot is inflight", async () => {
    const coldStore = { id: "cold-store" } as unknown as import("@fusion/core").TaskStore;
    const hostStore = { id: "late-host-store" } as unknown as import("@fusion/core").TaskStore;
    let resolveBoot: ((value: Awaited<ReturnType<typeof import("@fusion/core").createTaskStoreForBackend>>) => void) | undefined;
    const shutdown = vi.fn(async () => {});
    __setExtensionStoreBootFactoryForTesting((() => new Promise((resolve) => {
      resolveBoot = resolve;
    })) as typeof import("@fusion/core").createTaskStoreForBackend);
    const inflightRoot = `${root}-late-host`;

    const waiting = __getStoreForTesting(inflightRoot, 100);
    setHostTaskStore(inflightRoot, hostStore);
    resolveBoot!({ taskStore: coldStore, shutdown } as Awaited<ReturnType<typeof import("@fusion/core").createTaskStoreForBackend>>);

    await expect(waiting).resolves.toBe(hostStore);
    expect(__peekCachedStoreForTesting(inflightRoot)).toBe(hostStore);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("fails a controllable wedged cold boot at the bounded caller budget", async () => {
    const factory = vi.fn(() => new Promise<never>(() => {}));
    __setExtensionStoreBootFactoryForTesting(factory as typeof import("@fusion/core").createTaskStoreForBackend);
    const wedgedRoot = `${root}-wedged`;

    await expect(__getStoreForTesting(wedgedRoot, 20)).rejects.toThrow(/timed out after 20ms/);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("applies cooldown after a hard cold-boot failure", async () => {
    const factory = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    __setExtensionStoreBootFactoryForTesting(factory as typeof import("@fusion/core").createTaskStoreForBackend);
    const failedRoot = `${root}-failed`;

    await expect(__getStoreForTesting(failedRoot, 100)).rejects.toThrow("backend unavailable");
    await expect(__getStoreForTesting(failedRoot, 100)).rejects.toThrow(/recently failed/);
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe("wrapExtensionToolExecute timeout abort", () => {
  it("aborts the tool signal when the outer budget expires so nested work can stop", async () => {
    let seenSignal: AbortSignal | undefined;
    const execute = vi.fn((_id: string, _params: unknown, signal?: AbortSignal) => {
      seenSignal = signal;
      return new Promise(() => {
        /* never settles */
      });
    });
    const wrapped = wrapExtensionToolExecute("fn_budget", execute, 30);
    const result = await wrapped("id", {}, undefined);
    expect(result).toMatchObject({ isError: true });
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe("raceWithTimeoutAndAbort", () => {
  it("resolves when the promise wins", async () => {
    await expect(
      raceWithTimeoutAndAbort(Promise.resolve("ok"), 1_000, undefined, "t"),
    ).resolves.toBe("ok");
  });

  it("rejects on timeout", async () => {
    await expect(
      raceWithTimeoutAndAbort(
        new Promise(() => {
          /* never settles */
        }),
        20,
        undefined,
        "slow-tool",
      ),
    ).rejects.toThrow(/slow-tool timed out after 20ms/);
  });

  it("rejects when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = raceWithTimeoutAndAbort(
      new Promise(() => {
        /* never settles */
      }),
      5_000,
      controller.signal,
      "aborted-tool",
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      raceWithTimeoutAndAbort(Promise.resolve("late"), 1_000, controller.signal, "pre-aborted"),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("wrapExtensionToolExecute", () => {
  it("returns the tool result on success", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "hi" }] }));
    const wrapped = wrapExtensionToolExecute("fn_demo", execute, 1_000);
    await expect(wrapped("id", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "hi" }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("converts timeouts into isError tool results instead of hanging", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execute = vi.fn(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    const wrapped = wrapExtensionToolExecute("fn_hang", execute, 25);
    const result = await wrapped("id", {}, undefined);
    expect(result).toMatchObject({
      isError: true,
      details: { error: expect.stringMatching(/timed out after 25ms/) },
    });
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("fn_hang failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fn_hang"));
  });

  it("converts abort into isError tool results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const execute = vi.fn(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    const wrapped = wrapExtensionToolExecute("fn_abort", execute, 5_000);
    const pending = wrapped("id", {}, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      isError: true,
      details: { error: "aborted" },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fn_abort aborted"));
  });
});
