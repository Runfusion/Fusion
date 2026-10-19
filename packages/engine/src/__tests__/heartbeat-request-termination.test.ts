/**
 * FNXC:HeartbeatTermination 2026-10-17-19:05:
 * Heartbeat real-loop regressions against the ACTUAL @earendil-works/pi-agent-core@1.1.0 loop reached
 * through the public @earendil-works/pi-coding-agent createAgentSession factory. Nothing from the SDK
 * is mocked: the factory, AgentSession, Agent, tool pipeline, and agent-loop all run for real. ONLY
 * the model provider is deterministic, injected at the supported ModelRuntime.registerProvider
 * ({ streamSimple }) boundary — requests still traverse the real runtime/Agent loop.
 *
 * Invariant: once a heartbeat signals successful completion, or an operator/pause cancels it, no
 * further model request may leave the process and no further retry may be scheduled.
 *
 * Determinism: the fake provider never observes AbortSignal (non-cooperative by construction), so no
 * assertion relies on provider cooperation. Timing is sequenced through explicit deferred gates and
 * public lifecycle waits (session.waitForIdle), never sleeps. No network, no real model, no real
 * credentials, no live configuration: ModelRuntime.create uses modelsPath:null (in-memory models
 * store), allowModelNetwork:false, refreshOnCreate:false, and an InMemoryCredentialStore;
 * settingsManager.inMemory carries cacheWarming:"off"; cwd/agentDir are owned empty temp dirs; the
 * resourceLoader is an owned empty stub satisfying the public ResourceLoader interface.
 *
 * Each gap-documenting "bare" test asserts what the UNWIRED 1.1.0 loop actually does today (the
 * pre-fix symptom, the RED baseline for the invariant); its "wired" sibling asserts the production
 * monitor-state hook chain closes it (GREEN). These intent-only windows do not claim that the SDK
 * lacks protection for a caller AbortSignal arriving before its first dispatch.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession as SdkAgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  Type,
  type AssistantMessage,
  type JsonObject,
} from "@earendil-works/pi-ai";
import { installHeartbeatTerminationHooks, HeartbeatTerminationRequestedError, createHeartbeatPromptAttemptRunner } from "../agents/heartbeat-termination-hooks.js";

/* ─────────────────────────────────────────────────────────────────────────────
 * Deterministic provider fixture (provider boundary only — the loop stays real)
 * ──────────────────────────────────────────────────────────────────────────── */

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

interface DeferredGate {
  promise: Promise<void>;
  resolve: () => void;
}

interface ScriptedResponse {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** When set, the fake stream parks mid-response until released — the non-cooperative mid-stream pause point. */
  pauseGate?: { entered: DeferredGate; release: DeferredGate };
}

interface FakeProvider {
  requests: number;
  signalsSeen: number;
}

interface OwnedDirs {
  cwd: string;
  agentDir: string;
}

/*
 * FNXC:HeartbeatTermination 2026-10-18-07:05:
 * One api identity for provider level AND model level, because Pi 1.1.0's composed provider only
 * forwards to a registered `streamSimple` when the request model's api equals the extension's own
 * api. A loopback URL is declared for the mandatory `baseUrl` and is never contacted.
 */
const FAKE_PROVIDER_API = "heartbeat-guard-fake-api";
const FAKE_PROVIDER_BASE_URL = "http://127.0.0.1:9/heartbeat-guard-never-dialed";

interface FakeSessionEnv {
  runtime: ModelRuntime;
  model: ReturnType<ModelRegistry["find"]> & {};
  provider: FakeProvider;
  dirs: OwnedDirs;
  /** Script a fresh deterministic response sequence; sticky repeats the final entry indefinitely. */
  setScript(responses: ScriptedResponse[], sticky?: boolean): void;
}

const ownedDirs: OwnedDirs[] = [];

/** FNXC:HeartbeatTermination 2026-10-19-11:20: Allocate test-owned session directories and register them for teardown. */
function makeOwnedDirs(): OwnedDirs {
  const base = mkdtempSync(join(tmpdir(), "heartbeat-guard-heartbeat-"));
  const dirs = { cwd: join(base, "cwd"), agentDir: join(base, "agentDir") };
  ownedDirs.push(dirs);
  return dirs;
}

afterAll(() => {
  for (const dirs of ownedDirs) {
    try {
      rmSync(join(dirs.cwd, ".."), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* owned temp only; never fatal */
    }
  }
});

/** FNXC:HeartbeatTermination 2026-10-19-11:20: Keep real SDK sessions isolated from the machine's extensions, skills and prompt files. */
function createEmptyResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** FNXC:HeartbeatTermination 2026-10-19-11:20: Build a protocol-valid deterministic response for the real SDK agent loop. */
function buildAssistantMessage(
  model: { api: string; provider: string; id: string },
  spec: ScriptedResponse,
  stopReason: "toolUse" | "stop",
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (spec.text) content.push({ type: "text", text: spec.text });
  for (const call of spec.toolCalls ?? []) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
  }
  return {
    role: "assistant",
    content,
    api: model.api as never,
    provider: model.provider as never,
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Builds one fully deterministic ModelRuntime per test. The stream handler never inspects
 * options.signal — this is the non-cooperative provider the invariant must survive.
 */
async function createFakeSdkEnv(): Promise<FakeSessionEnv> {
  const dirs = makeOwnedDirs();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const provider: FakeProvider = { requests: 0, signalsSeen: 0 };
  let responses: ScriptedResponse[] = [];
  let stickyLast = false;
  let lastResponse: ScriptedResponse | undefined;
  /*
   * FNXC:HeartbeatTermination 2026-10-18-07:05:
   * Actual 1.1.0 public registerProvider contract (verified against the installed
   * dist/core/provider-composer.js, not assumed): `validateExtensionProvider` requires a PROVIDER-level
   * `api` whenever `streamSimple` is supplied; `extensionModelFromDefinition` requires a non-empty
   * `baseUrl` for a new custom model and resolves each model's api as
   * `definition.api ?? config.api ?? defaults?.api`; and `composeModelProvider` dispatches the
   * synthetic `streamSimple` ONLY when `model.api === extension.api`. All three declared fields are
   * therefore the SAME constant. `baseUrl` is an inert loopback that is never dialed — the synthetic
   * stream is the only replaced seam, so no request leaves the process.
   */
  runtime.registerProvider("heartbeat-guard-fake", {
    name: "Heartbeat Fake",
    api: FAKE_PROVIDER_API,
    baseUrl: FAKE_PROVIDER_BASE_URL,
    apiKey: "heartbeat-guard-not-a-real-credential",
    models: [{
      id: "fake-agent",
      name: "Fake Agent",
      api: FAKE_PROVIDER_API,
      baseUrl: FAKE_PROVIDER_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    }],
    streamSimple: (model, _context, options) => {
      // Dispatch proof: a mismatched api would fall through to pi-ai's api registry and throw there,
      // so asserting it here keeps a future contract change from silently replacing this seam.
      if (model.api !== FAKE_PROVIDER_API) {
        throw new Error(`Synthetic provider was bypassed: request carried api "${model.api}"`);
      }
      provider.requests++;
      if (options?.signal) provider.signalsSeen++;
      let spec = responses.shift();
      if (!spec) {
        // Sticky mode keeps a nonterminal response repeating so multi-turn fixtures never depend on
        // microtask refill loops; termination must still come only from the engine control.
        spec = stickyLast && lastResponse ? lastResponse : { text: "script-exhausted" };
      }
      lastResponse = spec;
      const finalMessage = buildAssistantMessage(
        { api: String(model.api), provider: model.provider, id: model.id },
        spec,
        spec.toolCalls && spec.toolCalls.length > 0 ? "toolUse" : "stop",
      );
      const stream = createAssistantMessageEventStream();
      // Push asynchronously so the caller receives the stream before any event lands.
      void (async () => {
        stream.push({ type: "start", partial: { ...finalMessage, stopReason: "pending" } });
        const pushCalls = (from: number) => {
          finalMessage.content.forEach((item, contentIndex) => {
            if (item.type === "toolCall" && contentIndex >= from) {
              stream.push({ type: "toolcall_start", contentIndex, toolCall: item, partial: finalMessage } as never);
              stream.push({ type: "toolcall_end", contentIndex, toolCall: item, partial: finalMessage } as never);
            }
          });
        };
        if (spec.pauseGate) {
          // Stream the partial response, park WITHOUT ending, then finish ignoring any abort.
          spec.pauseGate.entered.resolve();
          await spec.pauseGate.release.promise;
        }
        // (pauseGate usage matches DeferredGate: resolve on entered, await promise on release)
        pushCalls(0);
        stream.end(finalMessage);
      })();
      return stream;
    },
  });
  const registry = new ModelRegistry(runtime);
  await registry.refresh();
  const model = registry.find("heartbeat-guard-fake", "fake-agent");
  if (!model) throw new Error("synthetic heartbeat-guard-fake model was not registered");
  return {
    runtime,
    model,
    provider,
    dirs,
    setScript(next, sticky) {
      responses = next;
      stickyLast = sticky ?? false;
    },
  };
}


/** FNXC:HeartbeatTermination 2026-10-19-11:20: Coordinate cancellation and stream preparation without real-time sleeps. */
function deferredGate(): DeferredGate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** FNXC:HeartbeatTermination 2026-10-19-11:20: Open a real SDK session with the fixture provider and monitor-state termination hooks. */
async function openHeartbeatSession(env: FakeSessionEnv, state: { stopped: boolean; steer?: boolean }) {
  let session!: SdkAgentSession;
  const tools: ToolDefinition[] = [{
    name: "note", label: "Note", description: "Record a note.",
    parameters: Type.Object({}),
    execute: async () => {
      if (state.steer) {
        state.steer = false;
        void session.steer("queued steering").catch(() => {});
      }
      return { content: [{ type: "text" as const, text: "noted" }], details: {} };
    },
  }, {
    name: "fn_heartbeat_done", label: "Done", description: "Finish the heartbeat.",
    parameters: Type.Object({}),
    execute: async () => {
      state.stopped = true;
      return { content: [{ type: "text" as const, text: "done" }], details: {}, terminate: true };
    },
  }];
  ({ session } = await createAgentSession({
    cwd: env.dirs.cwd, agentDir: env.dirs.agentDir,
    modelRuntime: env.runtime, model: env.model,
    resourceLoader: createEmptyResourceLoader(),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
    customTools: tools, noTools: "builtin",
  }));
  return session;
}

describe("heartbeat terminal request fence with the real Pi loop", () => {
  it.each([false, true])("mixed tool batch: hooks=%s", async (wired) => {
    const env = await createFakeSdkEnv();
    const state = { stopped: false };
    const session = await openHeartbeatSession(env, state);
    if (wired) installHeartbeatTerminationHooks(session, () => state.stopped);
    env.setScript([{
      toolCalls: [
        { id: "note-1", name: "note", arguments: {} },
        { id: "done-1", name: "fn_heartbeat_done", arguments: {} },
      ],
    }, { text: "unwanted extra request" }]);
    try {
      await session.prompt("heartbeat");
      await session.waitForIdle();
      expect(state.stopped).toBe(true);
      expect(env.provider.requests).toBe(wired ? 1 : 2);
    } finally { session.dispose(); }
  });

  it("does not dispatch queued steering after completion", async () => {
    const env = await createFakeSdkEnv();
    const state = { stopped: false, steer: true };
    const session = await openHeartbeatSession(env, state);
    installHeartbeatTerminationHooks(session, () => state.stopped);
    env.setScript([{ toolCalls: [
      { id: "note-1", name: "note", arguments: {} },
      { id: "done-1", name: "fn_heartbeat_done", arguments: {} },
    ] }]);
    try {
      await session.prompt("heartbeat");
      await session.waitForIdle();
      expect(env.provider.requests).toBe(1);
      // The SDK may consume steering into context before finishTurn; it must not dispatch it.
      expect(state.steer).toBe(false);
    } finally { session.dispose(); }
  });

  it.each([false, true])("cancellation while a previous prepareRequest is pending: hooks=%s", async (wired) => {
    const env = await createFakeSdkEnv();
    const state = { stopped: false };
    const session = await openHeartbeatSession(env, state);
    const entered = deferredGate();
    const release = deferredGate();
    const previous = session.agent.prepareRequest;
    session.agent.prepareRequest = async (request, signal) => {
      entered.resolve();
      await release.promise;
      return previous?.(request, signal);
    };
    if (wired) installHeartbeatTerminationHooks(session, () => state.stopped);
    env.setScript([{ text: "must be fenced" }]);
    try {
      const prompt = session.prompt("heartbeat").catch(() => undefined);
      await entered.promise;
      // No bound abortable session in this replacement window: intent is the authority.
      state.stopped = true;
      release.resolve();
      await prompt;
      await session.waitForIdle();
      expect(env.provider.requests).toBe(wired ? 0 : 1);
    } finally { release.resolve(); session.dispose(); }
  });

  it("fences a replacement session created after terminal intent", async () => {
    const env = await createFakeSdkEnv();
    const state = { stopped: true };
    const session = await openHeartbeatSession(env, state);
    installHeartbeatTerminationHooks(session, () => state.stopped);
    env.setScript([{ text: "must not dispatch" }]);
    try {
      await session.prompt("replacement").catch(() => undefined);
      await session.waitForIdle();
      expect(env.provider.requests).toBe(0);
    } finally { session.dispose(); }
  });

  it("preserves prior SDK hooks on the normal request path", async () => {
    const env = await createFakeSdkEnv();
    const state = { stopped: false };
    const session = await openHeartbeatSession(env, state);
    let preparations = 0;
    let turns = 0;
    const prepare = session.agent.prepareRequest;
    const finish = session.agent.finishTurn;
    session.agent.prepareRequest = async (request, signal) => {
      preparations++;
      return prepare?.(request, signal);
    };
    session.agent.finishTurn = async (turn, signal) => {
      turns++;
      return finish?.(turn, signal);
    };
    installHeartbeatTerminationHooks(session, () => state.stopped);
    env.setScript([{ text: "ordinary response" }]);
    try {
      await session.prompt("heartbeat");
      await session.waitForIdle();
      expect(env.provider.requests).toBe(1);
      expect(preparations).toBe(1);
      expect(turns).toBe(1);
    } finally { session.dispose(); }
  });
});

describe("heartbeat retry attempt termination", () => {
  it("only swallows expected termination after this run's terminal intent", async () => {
    let stopped = false;
    const run = createHeartbeatPromptAttemptRunner(() => stopped);
    const abort = new Error("aborted"); abort.name = "AbortError";
    await expect(run(async () => { throw abort; })).rejects.toBe(abort);
    stopped = true;
    await expect(createHeartbeatPromptAttemptRunner(() => true)(async () => { throw abort; })).resolves.toBeUndefined();
    await expect(createHeartbeatPromptAttemptRunner(() => true)(async () => { throw new HeartbeatTerminationRequestedError(); })).resolves.toBeUndefined();
    const failure = new Error("provider 500");
    await expect(createHeartbeatPromptAttemptRunner(() => true)(async () => { throw failure; })).rejects.toBe(failure);
  });

  it("does not replace a genuine failure when an in-flight rotation re-enters after completion", async () => {
    let stopped = false;
    const run = createHeartbeatPromptAttemptRunner(() => stopped);
    const failure = new Error("rate limit");
    await expect(run(async () => { stopped = true; throw failure; })).rejects.toBe(failure);
    let dispatched = false;
    await expect(run(async () => { dispatched = true; })).rejects.toBe(failure);
    expect(dispatched).toBe(false);
  });
});
