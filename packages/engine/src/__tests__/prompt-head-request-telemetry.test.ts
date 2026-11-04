import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { promptWithFallback } from "../pi.js";
import {
  attachPromptHeadRecord,
  resetPromptHeadDivergenceLedger,
  type PromptHeadRecord,
} from "../agents/prompt-telemetry.js";

/**
 * RUFU-284 Step 4: `prompt_head` / `prompt_end` are per-REQUEST evidence rows. The acceptance claims
 * they exist to verify (RUFU-267 byte-stability, RUFU-268 cache-read rise) are per-request questions,
 * so a session-level emit would answer nothing — and the rows must never carry the prompt itself.
 */

const PRIVATE_MARKERS = [
  "PRIVATE_SYSTEM_PROMPT_BODY",
  "PRIVATE_SOUL_TEXT",
  "PRIVATE_MEMORY_ENTRY",
  "/home/user/private-worktree",
] as const;

interface EmittedEvent {
  kind: string;
  taskId?: string | null;
  agentId?: string | null;
  nodeId?: string | null;
  category?: string;
  meta?: Record<string, unknown>;
}

function fakeStore(): { emitUsageEvent: ReturnType<typeof vi.fn>; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const emitUsageEvent = vi.fn((event: EmittedEvent) => {
    events.push(event);
    return Promise.resolve(true);
  });
  return { emitUsageEvent, events };
}

/** A pi-shaped session whose prompt call is a no-op, plus an optional attached-dispatch closure. */
function fakeSession(options: { attached?: boolean; nested?: boolean; fail?: boolean } = {}) {
  const prompts: string[] = [];
  const session = {
    model: { provider: "anthropic", id: "claude-test" },
    state: {},
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      if (options.fail) throw new Error("provider exploded");
    }),
  } as unknown as AgentSession & { prompt: ReturnType<typeof vi.fn> };
  if (options.attached) {
    (session as unknown as { promptWithFallback?: (p: string, o?: unknown) => Promise<void> }).promptWithFallback =
      async (text: string) => {
        await session.prompt(text);
        if (options.nested) {
          // pi's attached closure re-enters the exported dispatcher for the SAME session.
          await promptWithFallback(session, `${text} (retry)`);
        }
      };
  }
  return { session, prompts };
}

function attach(
  session: AgentSession,
  store: ReturnType<typeof fakeStore>,
  head: { stable: string; dynamic?: string },
): void {
  attachPromptHeadRecord(session, {
    lane: "executor",
    store: store as never,
    source: "engine-assembly",
    runtimeId: "pi",
    readHead: () => head,
    agentId: "agent-284",
    taskId: "FN-284",
    nodeId: null,
    sessionEpoch: 1,
  } as PromptHeadRecord);
}

function rowsOf(events: EmittedEvent[], kind: string): EmittedEvent[] {
  return events.filter((event) => event.kind === kind);
}

beforeEach(() => {
  resetPromptHeadDivergenceLedger();
});

describe("per-request head/tail emission", () => {
  it("leaves one head and one tail row PER request, not one per session", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    attach(session, store, { stable: "You are the executor." });

    await promptWithFallback(session, "first");
    await promptWithFallback(session, "second");

    expect(rowsOf(store.events, "prompt_head")).toHaveLength(2);
    expect(rowsOf(store.events, "prompt_end")).toHaveLength(2);
  });

  it("pairs head and tail on one requestId and reports the request outcome", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    attach(session, store, { stable: "You are the executor." });
    await promptWithFallback(session, "go");

    const head = rowsOf(store.events, "prompt_head")[0]!;
    const end = rowsOf(store.events, "prompt_end")[0]!;
    expect(head.meta?.requestId).toEqual(expect.any(String));
    expect(end.meta?.requestId).toBe(head.meta?.requestId);
    expect(end.meta).toMatchObject({ lane: "executor", outcome: "completed", durationMs: expect.any(Number) });
    expect(head.meta).toMatchObject({
      lane: "executor",
      headBytes: expect.any(Number),
      staticBytes: expect.any(Number),
      source: "engine-assembly",
      runtimeId: "pi",
      sessionEpoch: 1,
    });
    expect(String(head.meta?.headHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(head.taskId).toBe("FN-284");
    expect(head.agentId).toBe("agent-284");
  });

  it("still pairs a tail row when the request itself fails", async () => {
    const store = fakeStore();
    const { session } = fakeSession({ fail: true });
    attach(session, store, { stable: "You are the executor." });
    await expect(promptWithFallback(session, "go")).rejects.toThrow(/provider exploded|Context limit/);

    const end = rowsOf(store.events, "prompt_end")[0]!;
    expect(end.meta?.outcome).toBeTruthy();
    expect(end.meta?.requestId).toBe(rowsOf(store.events, "prompt_head")[0]?.meta?.requestId);
  });

  it("counts the attached-dispatch closure as ONE request even when it re-enters the dispatcher", async () => {
    const store = fakeStore();
    const { session, prompts } = fakeSession({ attached: true, nested: true });
    attach(session, store, { stable: "You are the executor." });

    await promptWithFallback(session, "go");

    // The dispatch branch is the executor's dominant path and must not be silent, and its internal
    // re-entry must not inflate requestCount.
    expect(prompts).toHaveLength(2);
    expect(rowsOf(store.events, "prompt_head")).toHaveLength(1);
    expect(rowsOf(store.events, "prompt_end")).toHaveLength(1);
  });

  it("emits nothing for a session that attached no lane, so unwired callers are unchanged", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    await promptWithFallback(session, "go");
    expect(store.events).toHaveLength(0);
  });
});

describe("divergence against the lane's previous request", () => {
  it("reports baseline then identical for a byte-stable head", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    attach(session, store, { stable: "You are the executor." });

    await promptWithFallback(session, "one");
    await promptWithFallback(session, "two");

    const heads = rowsOf(store.events, "prompt_head");
    expect(heads[0]?.meta).toMatchObject({ divergenceStatus: "baseline", firstDivergenceOffset: null });
    expect(heads[1]?.meta).toMatchObject({ divergenceStatus: "identical", firstDivergenceOffset: null });
  });

  it("names the first differing byte when a lane's head changes mid-window", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    const headOne = "You are the executor.\nSTATIC RULE";
    const headTwo = "You are the executor.\nSTATIC RULES";
    let head = headOne;
    attachPromptHeadRecord(session, {
      lane: "executor",
      store: store as never,
      source: "engine-assembly",
      runtimeId: "pi",
      readHead: () => ({ stable: head }),
      agentId: null,
      taskId: null,
      nodeId: null,
      sessionEpoch: 1,
    } as PromptHeadRecord);

    await promptWithFallback(session, "one");
    head = headTwo;
    await promptWithFallback(session, "two");

    const heads = rowsOf(store.events, "prompt_head");
    expect(heads[1]?.meta).toMatchObject({
      divergenceStatus: "diverged",
      firstDivergenceOffset: Buffer.byteLength(headOne, "utf8"),
      offsetBucket: "lt128",
    });
  });

  it("separates the volatile tail so its size is visible without touching the head", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    attach(session, store, { stable: "STABLE", dynamic: "volatile tail" });
    await promptWithFallback(session, "go");

    expect(rowsOf(store.events, "prompt_head")[0]?.meta).toMatchObject({
      staticBytes: 6,
      dynamicBytes: 13,
      dynamicStart: 6,
    });
  });
});

describe("privacy and single-row boundaries", () => {
  it("never carries the prompt, soul, memory, or a worktree path in either row", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    attach(session, store, {
      stable: `System: ${PRIVATE_MARKERS[0]} soul=${PRIVATE_MARKERS[1]} memory=${PRIVATE_MARKERS[2]} cwd=${PRIVATE_MARKERS[3]}`,
      dynamic: PRIVATE_MARKERS[1],
    });
    await promptWithFallback(session, "go");

    const serialized = JSON.stringify(rowsOf(store.events, "prompt_head").concat(rowsOf(store.events, "prompt_end")));
    for (const marker of PRIVATE_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("keeps token numbers out of prompt_end — token_usage owns them", async () => {
    const store = fakeStore();
    const { session } = fakeSession();
    attach(session, store, { stable: "STABLE" });
    await promptWithFallback(session, "go");

    const meta = rowsOf(store.events, "prompt_end")[0]!.meta!;
    expect(Object.keys(meta).filter((key) => /token|cost|usage/i.test(key))).toEqual([]);
    expect(meta).toMatchObject({ lane: "executor", requestId: expect.any(String), outcome: "completed", durationMs: expect.any(Number) });
  });
});
