import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCreateInteractiveAiSessionFactory,
  setCreateInteractiveAiSessionFactory,
} from "../ai/ai-engine-loader.js";
import { PluginLoader } from "../plugins/plugin-loader.js";
import type {
  CreateInteractiveAiSessionFactory,
  InteractiveAiSession,
  InteractiveAiSessionEvent,
} from "../plugins/plugin-types.js";
import type { PlanningQuestion } from "../types.js";

/**
 * A scripted fake interactive session: drives question → answer → complete
 * deterministically so the route-context seam can be integration-tested
 * without a live engine/model.
 */
function makeScriptedSession(script: InteractiveAiSessionEvent[]): InteractiveAiSession {
  let cursor = -1;
  return {
    prompt: vi.fn(async () => {
      cursor++;
    }),
    answer: vi.fn(async () => {
      cursor++;
    }),
    nextEvent: vi.fn(async () => script[Math.min(cursor, script.length - 1)]),
    dispose: vi.fn(),
  } as InteractiveAiSession;
}

afterEach(() => {
  setCreateInteractiveAiSessionFactory(undefined);
});

describe("ai-engine-loader: interactive factory DI", () => {
  it("returns undefined before registration", async () => {
    await expect(getCreateInteractiveAiSessionFactory()).resolves.toBeUndefined();
  });

  it("stores, returns, and clears the factory", async () => {
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async () => ({
      session: makeScriptedSession([{ type: "complete", data: {} }]),
    }));
    setCreateInteractiveAiSessionFactory(factory);
    await expect(getCreateInteractiveAiSessionFactory()).resolves.toBe(factory);
    setCreateInteractiveAiSessionFactory(undefined);
    await expect(getCreateInteractiveAiSessionFactory()).resolves.toBeUndefined();
  });
});

describe("interactive session injection boundary", () => {
  function makeLoader() {
    const pluginStore = {
      getPlugin: vi.fn().mockResolvedValue({ settings: {} }),
    } as never;
    const taskStore = { getRootDir: () => "/tmp" } as never;
    return new PluginLoader({ pluginStore, taskStore });
  }

  it("route context exposes createInteractiveAiSession when engine registered it; absent otherwise", async () => {
    const loader = makeLoader();

    // Not registered → undefined on route context.
    const before = await loader.createRouteContext("fusion-plugin-x");
    expect(before.createInteractiveAiSession).toBeUndefined();

    const factory: CreateInteractiveAiSessionFactory = vi.fn(async () => ({
      session: makeScriptedSession([{ type: "complete", data: {} }]),
    }));
    setCreateInteractiveAiSessionFactory(factory);

    const after = await loader.createRouteContext("fusion-plugin-x");
    expect(after.createInteractiveAiSession).toBe(factory);
  });

  it("drives a full question → answer → complete round trip from a route context", async () => {
    const question: PlanningQuestion = { id: "q1", type: "single_select", question: "Pick", options: [{ id: "a", label: "A" }] };
    const session = makeScriptedSession([
      { type: "question", data: question },
      { type: "complete", data: { title: "ok" } },
    ]);
    const factory: CreateInteractiveAiSessionFactory = vi.fn(async () => ({ session, sessionFile: "/tmp/s.json" }));
    setCreateInteractiveAiSessionFactory(factory);

    const loader = makeLoader();
    const ctx = await loader.createRouteContext("fusion-plugin-x");
    expect(ctx.createInteractiveAiSession).toBeDefined();

    const { session: s } = await ctx.createInteractiveAiSession!({ cwd: "/tmp", systemPrompt: "protocol" });

    await s.prompt("start");
    const ev1 = await s.nextEvent();
    expect(ev1.type).toBe("question");
    expect(ev1.type === "question" && ev1.data.id).toBe("q1");

    await s.answer("q1", "a");
    const ev2 = await s.nextEvent();
    expect(ev2.type).toBe("complete");

    s.dispose();
    expect(s.dispose).toHaveBeenCalled();
  });
});
