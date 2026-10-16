import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __clearExtensionStoreBootStateForTesting,
  __getStoreForTesting,
  __resolveProjectRootForTesting,
  __setCachedStoreForTesting,
  __setExtensionStoreBootFactoryForTesting,
  buildStoreBootStallResult,
  clearHostTaskStores,
  closeCachedStores,
  formatBootStages,
  setHostTaskStore,
  TaskStoreBootTransientError,
} from "../extension.js";
import type { BootStage, TaskStore } from "@fusion/core";

/*
FNXC:TaskStoreBootStageAttribution 2026-10-16-04:30 (STAS-335):
A boot that burned its budget used to report only the budget. The five stage timings existed, but
they left the process as `log.log`/console output, and for an agent session that channel is discarded
(the extension is forked with `silent: true` and IPC alone is forwarded), so a stall that already
happened could not be attributed to a stage by anyone. These tests pin the two properties that fix it:
the stage record travels WITH the typed error to the caller, and it lands in the tool result an agent
actually reads — which is the durable channel, because the tool result is recorded in the task log.

The second block pins the teardown ownership invariant the shared-handle work must never break: the
extension stops stores it opened and never stops a store the host opened.
*/

const PROJECT_ROOT = __resolveProjectRootForTesting(process.cwd());
const TINY_BUDGET_MS = 20;

type BootFactoryArg = Parameters<typeof __setExtensionStoreBootFactoryForTesting>[0];

function bootFactory(factory: (options: { onBootStage?: (stage: BootStage) => void }) => Promise<unknown>): BootFactoryArg {
  return factory as unknown as BootFactoryArg;
}

/** Reports two stages, then hangs: the waiter abandons it, the orphan keeps its stage record. */
function stallAfterReportingStages(options: { onBootStage?: (stage: BootStage) => void }): Promise<never> {
  options.onBootStage?.({ phase: "connect", durationMs: 4, ok: true });
  options.onBootStage?.({ phase: "applySchema", durationMs: 31, ok: true });
  return new Promise<never>(() => {});
}

function fakeStore(): TaskStore {
  return { id: "fake-store" } as unknown as TaskStore;
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined).catch((caught: unknown) => caught);
}

afterEach(async () => {
  await closeCachedStores();
  __clearExtensionStoreBootStateForTesting();
  clearHostTaskStores();
  vi.restoreAllMocks();
});

describe("a stalled boot names the stage it reached, not just the budget it burned (STAS-335)", () => {
  it("carries the factory's per-stage record on the transient error the waiter receives", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory(stallAfterReportingStages));

    const error = await reject(__getStoreForTesting(PROJECT_ROOT, TINY_BUDGET_MS)) as TaskStoreBootTransientError;

    expect(error).toBeInstanceOf(TaskStoreBootTransientError);
    /* The point of the record is that it names where the time went, so an operator does not have to
       re-run the boot to learn which stage is slow. */
    expect(error.stages).toEqual([
      { phase: "connect", durationMs: 4, ok: true },
      { phase: "applySchema", durationMs: 31, ok: true },
    ]);
    expect(error.elapsedMs).toBeGreaterThanOrEqual(TINY_BUDGET_MS);
  });

  it("surfaces the attribution in the tool result, where it survives the discarded console", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory(stallAfterReportingStages));

    const error = await reject(__getStoreForTesting(PROJECT_ROOT, TINY_BUDGET_MS));
    const result = buildStoreBootStallResult("fn_task_update", error);

    const text = String(result.content[0]?.text);
    /* STAS-299 req 3's shipped first line stays byte-compatible: the retry instruction and the
       `X failed: <subject>` prefix are the contract agents were taught to act on. */
    expect(text).toMatch(/^fn_task_update failed: fn extension TaskStore boot timed out after 20ms\n/);
    expect(text).toContain("Retry this same call");
    expect(text).toContain("Boot attribution: connect=4ms applySchema=31ms");

    expect(result.details.attribution).toBe("connect=4ms applySchema=31ms");
    expect(result.details.stages).toHaveLength(2);
  });

  it("marks a stage that did not finish as failed, so the failing stage stays visible", () => {
    /* The FAILED marker is what distinguishes "applySchema is slow" from "applySchema hung" in a
       postmortem, and it is rendered from the stage the factory itself flagged. */
    expect(formatBootStages([
      { phase: "connect", durationMs: 3, ok: true },
      { phase: "applySchema", durationMs: 500, ok: false },
    ])).toBe("connect=3ms applySchema=500ms FAILED");
  });

  it("keeps a genuine boot failure a real failure rather than laundering it into a stall", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory((options) => {
      options.onBootStage?.({ phase: "connect", durationMs: 3, ok: true });
      return Promise.reject(new Error("schema apply exploded"));
    }));

    const error = await reject(__getStoreForTesting(PROJECT_ROOT, TINY_BUDGET_MS)) as Error;

    /* Invariant B (STAS-299): only running-out-of-time is a stall. A boot that failed for another
       reason stays fail-closed, so stage reporting must not widen the transient class. */
    expect(error).not.toBeInstanceOf(TaskStoreBootTransientError);
    expect(error.message).toContain("schema apply exploded");
  });

  it("says nothing completed rather than inventing a stage when the factory reported none", () => {
    expect(formatBootStages([])).toBe("no boot stage completed before the deadline");
  });

  it("carries the abandoned attempt's stages to a caller arriving inside the backoff window", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory(stallAfterReportingStages));

    await reject(__getStoreForTesting(PROJECT_ROOT, TINY_BUDGET_MS));
    const second = await reject(__getStoreForTesting(PROJECT_ROOT, TINY_BUDGET_MS)) as TaskStoreBootTransientError;

    expect(second).toBeInstanceOf(TaskStoreBootTransientError);
    expect(second.message).toContain("recently failed (cooldown");
    expect(second.stages.map((stage) => stage.phase)).toEqual(["connect", "applySchema"]);
  });

  it("keeps connection material out of the attribution it prints", async () => {
    __setExtensionStoreBootFactoryForTesting(bootFactory((options) => {
      /* A real stall reason the pool can produce verbatim (RUFU-377), carrying a URL-shaped host. */
      options.onBootStage?.({ phase: "connect", durationMs: 20_242, ok: false });
      return Promise.reject(new Error(
        "connection timed out after 20242ms at postgres://user:s3cret@db.internal:5432/fusion",
      ));
    }));

    const error = await reject(__getStoreForTesting(PROJECT_ROOT, TINY_BUDGET_MS));
    const attribution = formatBootStages((error as TaskStoreBootTransientError).stages);

    expect(attribution).toBe("connect=20242ms FAILED");
    expect(attribution).not.toMatch(/s3cret|postgres:\/\/|db\.internal/);
  });
});

describe("extension teardown stops only the stores the extension opened (STAS-335 invariant)", () => {
  /*
  The boot-sharing work makes one TaskStore serve many tool calls, which puts a tempting bug within
  reach: a session that merely JOINED a store it did not create running `session_shutdown` ->
  closeCachedStores() and stopping the embedded postmaster underneath every other session. These two
  tests are the cheap tripwire for that.
  */
  it("does not close a host-injected store, because the host owns its lifecycle", async () => {
    const store = fakeStore();
    const close = vi.fn();
    (store as unknown as { close: () => void }).close = close;
    setHostTaskStore(PROJECT_ROOT, store);

    await closeCachedStores();

    expect(close).not.toHaveBeenCalled();
  });

  it("does close a factory-owned store, because this process opened it", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    __setCachedStoreForTesting(PROJECT_ROOT, fakeStore(), shutdown);

    await closeCachedStores();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("serves a host-injected handle instead of racing it, and never owns it", async () => {
    const hostStore = fakeStore();
    const hostClose = vi.fn();
    (hostStore as unknown as { close: () => void }).close = hostClose;
    setHostTaskStore(PROJECT_ROOT, hostStore);

    __setExtensionStoreBootFactoryForTesting(bootFactory(stallAfterReportingStages));
    const served = await __getStoreForTesting(PROJECT_ROOT, TINY_BUDGET_MS);

    /* The host handle answers immediately, so a slow factory boot cannot even become a stall here —
       and because that handle was injected, this process must never be the one to close it. */
    expect(served).toBe(hostStore);
    await closeCachedStores();
    expect(hostClose).not.toHaveBeenCalled();
  });
});
