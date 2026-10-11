/**
 * RUFU-377 Step 3: an agent called `fn_agent_show` and received
 * `fn_agent_show failed: fn extension TaskStore boot timed out after 30000ms`.
 *
 * The Step-2 discriminator (`task-store-boot-concurrency.test.ts`) only proves which budget
 * expired when the caller goes to the store resolver directly. This file closes the two claims
 * that live one layer out, at the agent-class surface itself:
 *
 * 1. **The registered tool is the one that pays the budget.** `kbExtension` intercepts
 *    `pi.registerTool` and re-wraps every execute, so the deadline text can only reach an agent
 *    through `wrapExtensionToolExecute`. Asserting that on a hand-written wrapper would be a
 *    tautology, so the PostgreSQL-gated section below registers the real extension and drives the
 *    tools it actually registered — `fn_agent_show` / `fn_list_agents` / `fn_agent_org_chart`,
 *    representatives of the agent-class read family that share one `getAgentStore` → `getStore`
 *    resolution.
 * 2. **A tool-layer rejection keeps its attribution.** A cold-cache boot failure must surface
 *    *inside* the `${toolName} failed: ` prefix — the wrapper's job is to propagate the store-boot
 *    reason, not to relabel it as an agent-tool fault.
 *
 * Premise correction against the spec, re-verified on HEAD: `fn_agent_show` is NOT behind the
 * agent permission-policy gate — `applyAgentPolicyGateForExtensionTool` has 9 call sites on HEAD
 * (`fn_task_pause` / `fn_task_unpause` / `fn_task_retry` / `fn_agent_stop` / `fn_agent_start` /
 * `fn_agent_set_instructions` / `fn_workflow_update` / `fn_workflow_delete` / `fn_delegate_task`).
 * RUFU-275's `taskstore-boot-unavailable` deny cause therefore CANNOT be the shape this card saw;
 * only the tool-wrapper prefix `${toolName} failed: ` can, which is exactly the discriminator this
 * file pins.
 *
 * FNXC:TaskStoreBootDeadline 2026-09-28-05:20: No 30 000 ms of wall clock is burned here. The
 * deadline class is proven by arming the shared backoff through the registry seam with a tiny
 * budget and asserting the agent-class surface reads it at once, plus a fast-rejecting factory for
 * the propagated-failure shape. A hung factory a regressed tool actually awaited would park the
 * lane for the full real budget, so the registered-tool arm resolves its spy factory in 5 ms and
 * lets the zero-invocation counter carry the assertion.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import kbExtension, {
  __clearExtensionStoreBootStateForTesting,
  __getStoreForTesting,
  __resolveProjectRootForTesting,
  __setCachedStoreForTesting,
  __setExtensionStoreBootFactoryForTesting,
  closeCachedStores,
  wrapExtensionToolExecute,
} from "../extension.js";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
  type ToolResult,
} from "./pg-extension-harness.js";

/*
FNXC:CliTests 2026-09-28-09:12 (RUFU-388):
This file used to drive every arm from a hard-coded absolute path to one developer's checkout. The
extension resolves the canonical project root before it consults the store registry, so that constant
only ever passed on the machine it named: on any other host `resolveProjectRoot` walks past a directory
carrying no `.fusion` marker, the key the tools look up stops matching the key the arms seed, and the
twelve registry arms below break on a perfectly healthy product.

The fixture is a fresh temp directory per run instead, and the `.fusion` marker inside it is load-bearing
rather than decorative: `resolveProjectRoot` returns the FIRST ancestor carrying that marker, and this
host demonstrably has a `.fusion` directory at the temp root itself — measured during this card, an
unmarked fixture resolved to `/tmp`, not to the fixture. So the marker is what pins resolution to the
fixture on every host, and the `BOOT-REGISTRY-PARITY` case in the first describe is what turns that
derivation from an assumption into an asserted invariant (it goes red, loudly, if an ancestor ever
intercepts the walk). The `afterAll` below removes the directory.
*/
const FIXTURE_PROJECT_ROOT = mkdtempSync(join(tmpdir(), "rufu388-boot-registry-"));
/** The first thing `resolveProjectRoot` looks for; without it the upward walk continues to a foreign `.fusion`. */
mkdirSync(join(FIXTURE_PROJECT_ROOT, ".fusion"), { recursive: true });
/** A nested working directory under the fixture: tools are invoked from anywhere inside a project. */
const FIXTURE_NESTED_CWD = join(FIXTURE_PROJECT_ROOT, "packages", "cli");
mkdirSync(FIXTURE_NESTED_CWD, { recursive: true });
const TOOL_CALL_CWD = FIXTURE_PROJECT_ROOT;

/**
 * Repo root derived from this file's own location. Never `process.cwd()`: a vitest worker's cwd is
 * wherever the runner was invoked, so a source-region guard read through it would silently scan
 * nothing (or the wrong tree) on another host.
 */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Read a repo-relative source file for the structural scans in this file. */
function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

/**
 * Extract a top-level function body: its opening brace through the first column-0 `}` after it.
 * Bounding the region matters — a whole-file scan would let a construct used by a neighbouring
 * function satisfy an order assertion about the one being described.
 */
function extractFunctionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`source region not found: ${declaration}`);
  }
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open);
  if (end === -1) {
    throw new Error(`unterminated source region for: ${declaration}`);
  }
  return source.slice(open, end);
}

/** A store stand-in; the registry layer never touches it, only hands it back. */
function makeFakeStore(): TaskStore {
  return { fake: "ready-store" } as unknown as TaskStore;
}

/** A boot promise that never settles on its own — only the budget can end the wait. */
function makeHungBootFactory() {
  const calls: Array<{ projectRoot: string }> = [];
  let release: () => void = () => {};
  const landed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory = vi.fn(async (opts: { rootDir: string }) => {
    calls.push({ projectRoot: opts.rootDir });
    await landed;
    return { taskStore: makeFakeStore(), shutdown: async () => {} };
  });
  return {
    factory,
    calls,
    /** Number of times the factory has been entered, after its microtask flushes. */
    settled: () => new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => calls.length),
    release: () => release(),
  };
}

/** An agent tool body that resolves the store exactly like fn_agent_show does. */
function agentReadToolWithBudget(bootBudgetMs: number) {
  return wrapExtensionToolExecute("fn_agent_show", async () => {
    const store = await __getStoreForTesting(TOOL_CALL_CWD, bootBudgetMs);
    return { content: [{ type: "text" as const, text: `agents for ${(store as unknown as { fake: string }).fake}` }] };
  });
}

afterEach(async () => {
  // The shared registry is process-global: never leak a fake factory, cooldown, or cache entry.
  // The cache must go too — a ready entry left by one test short-circuits the next test's cold
  // boot before its budget is ever reached, which reads as "the budget never fires".
  await closeCachedStores();
  __setExtensionStoreBootFactoryForTesting(undefined);
  __clearExtensionStoreBootStateForTesting();
  vi.useRealTimers();
});

afterAll(() => {
  // The derived fixture outlives a single test, not the process. It holds only the `.fusion`
  // marker and the nested cwd — no store files, because the backend here is the external test
  // server — so there is nothing to drain beyond the cache close the afterEach already does.
  rmSync(FIXTURE_PROJECT_ROOT, { recursive: true, force: true });
});

describe("extension agent-class boot budget (RUFU-377)", () => {
  it("a ready cached store short-circuits before the budget wrapper is ever constructed", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);
    const root = __resolveProjectRootForTesting(TOOL_CALL_CWD);
    const ready = makeFakeStore();
    __setCachedStoreForTesting(root, ready);

    await expect(__getStoreForTesting(TOOL_CALL_CWD, 30_000)).resolves.toBe(ready);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(hung.calls).toHaveLength(0);
    expect(hung.factory).not.toHaveBeenCalled();
  });

  it("a cold agent-class call surfaces the deadline class INSIDE the tool-wrapper prefix", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);

    const pending = agentReadToolWithBudget(25)("call-1", { id: "agent-48a5da4e" }) as Promise<ToolResult>;
    await vi.advanceTimersByTimeAsync(26);
    const result = await pending;

    // The shape RUFU-377 actually saw: wrapper prefix + store-boot subject + bare deadline.
    expect(result.content[0]?.text ?? "").toMatch(
      /^fn_agent_show failed: fn extension TaskStore boot timed out after \d+ms$/,
    );
    expect(result.isError).toBe(true);
    expect(hung.calls).toHaveLength(1);
  });

  it("a tool-layer boot rejection after the deadline reads the cooldown class, not a bare timeout", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);

    // Step 2 proved the registry arms the backoff on a reported deadline; here the agent-class
    // surface must READ that backoff instead of re-paying the budget.
    const abandoning = __getStoreForTesting(TOOL_CALL_CWD, 25).catch((error) => error);
    await vi.advanceTimersByTimeAsync(26);
    await expect(abandoning).resolves.toBeInstanceOf(Error);

    const startedAt = Date.now();
    const result = (await agentReadToolWithBudget(30_000)("call-2", { id: "agent-48a5da4e" })) as ToolResult;
    const text = result.content[0]?.text ?? "";

    // An abandoned-but-live boot must not make the agent class pay 30 s a second time.
    expect(Date.now() - startedAt).toBeLessThan(25);
    expect(text).toContain("fn extension TaskStore boot recently failed");
    expect(text).not.toMatch(/timed out after \d+ms$/);
    expect(hung.calls).toHaveLength(1);
  });

  it("a boot that lands late serves the next agent-class call from the cache", async () => {
    vi.useFakeTimers();
    const hung = makeHungBootFactory();
    __setExtensionStoreBootFactoryForTesting(hung.factory as never);

    const abandoning = __getStoreForTesting(TOOL_CALL_CWD, 25).catch((error) => error);
    await vi.advanceTimersByTimeAsync(26);
    await abandoning;

    hung.release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => {
      await expect(__getStoreForTesting(TOOL_CALL_CWD, 25)).resolves.toBeTruthy();
    });

    // Cache-before-cooldown: the late landing outranks the backoff the deadline armed.
    const result = (await agentReadToolWithBudget(30_000)("call-3", { id: "agent-48a5da4e" })) as ToolResult;
    expect(result.content[0]?.text).toBe("agents for ready-store");
  });

  /*
  FNXC:CliTests 2026-09-28-09:12 (RUFU-388) — BOOT-REGISTRY-PARITY:
  Every arm in this file seeds the store registry under one cwd and reads it back through the resolver,
  which only tests what it claims while project-root resolution and the registry key agree. Nothing
  proved that agreement: the file previously assumed it by passing a hard-coded developer checkout path,
  so the arms silently depended on one machine's filesystem. This case asserts the invariant that
  assumption stood in for, in its general form rather than the single reported cwd — resolution is
  self-consistent and idempotent, a cwd nested inside the project resolves to the same root, and the one
  entry seeded under any of those spellings is what the resolver seam hands back for all of them.
  */
  it("BOOT-REGISTRY-PARITY: project-root resolution and the store registry key agree", async () => {
    const resolved = __resolveProjectRootForTesting(TOOL_CALL_CWD);
    expect(resolved).toBe(FIXTURE_PROJECT_ROOT);
    // Idempotent: re-resolution yields the same key, not a fresh derivation that could drift.
    expect(__resolveProjectRootForTesting(TOOL_CALL_CWD)).toBe(resolved);
    // The general form, not the reported cwd: a nested cwd lands on the same root.
    expect(__resolveProjectRootForTesting(FIXTURE_NESTED_CWD)).toBe(resolved);

    const store = makeFakeStore();
    __setCachedStoreForTesting(TOOL_CALL_CWD, store);

    // One registry entry serves every cwd spelling — no per-directory second boot.
    await expect(__getStoreForTesting(TOOL_CALL_CWD)).resolves.toBe(store);
    await expect(__getStoreForTesting(FIXTURE_NESTED_CWD)).resolves.toBe(store);
    await expect(__getStoreForTesting(resolved)).resolves.toBe(store);
  });
});

/*
FNXC:TaskStoreBootDeadline 2026-09-28-05:20:
Registered-tool arm (PostgreSQL-gated; the pgDescribe skip contract applies when the test server is
unreachable). The synthetic wrapper above proves the shape but not the wiring. This section proves
the wiring: it hands the real `kbExtension` a mock registration API, pulls the tools it registered,
and drives `execute()` — so a future agent-class surface that resolved its own store instead of the
shared seam cannot pass it. A ready store that reached the deadline wrapper would register factory
invocations, so the counter is the assertion; the spy resolves in 5 ms so a regression fails fast
instead of parking the lane for the real 30 s budget.
*/
const pgHarness = createPgExtensionHarness("rufu377-agentclass");

pgDescribe("registered agent-class tools share the one boot seam (RUFU-377)", () => {
  beforeAll(pgHarness.beforeAll);
  beforeEach(pgHarness.beforeEach);
  afterEach(pgHarness.afterEach);
  afterAll(pgHarness.afterAll);

  /** Register the real extension and hand back the tools it wrapped at registration time. */
  function registerAgentClassTools() {
    const api = createMockApi();
    registerExtension(api);
    return {
      ctx: { cwd: pgHarness.rootDir() },
      show: requireTool(api, "fn_agent_show"),
      list: requireTool(api, "fn_list_agents"),
      orgChart: requireTool(api, "fn_agent_org_chart"),
    };
  }

  it("fn_list_agents and fn_agent_org_chart read off the ready store with zero boot-factory invocations", async () => {
    const bootFactory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { taskStore: makeFakeStore(), shutdown: async () => {} };
    });
    __setExtensionStoreBootFactoryForTesting(bootFactory as never);
    const { ctx, list, orgChart } = registerAgentClassTools();

    const listed = (await list.execute("call-1", {}, undefined, undefined, ctx)) as ToolResult;
    const org = (await orgChart.execute("call-2", {}, undefined, undefined, ctx)) as ToolResult;

    // Ready store: both reads answer and nothing was booted — this surface provably never pays
    // the boot budget while a live store already exists in the process.
    expect(listed.isError, `fn_list_agents: ${listed.content[0]?.text}`).toBeFalsy();
    expect(org.isError, `fn_agent_org_chart: ${org.content[0]?.text}`).toBeFalsy();
    expect(((listed.details as { count?: number })?.count ?? 0), "harness provisions the durable built-in agents").toBeGreaterThan(0);
    expect(bootFactory).not.toHaveBeenCalled();
  });

  it("fn_agent_show serves a real agent off the ready store with zero boot-factory invocations", async () => {
    const bootFactory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { taskStore: makeFakeStore(), shutdown: async () => {} };
    });
    __setExtensionStoreBootFactoryForTesting(bootFactory as never);
    const { ctx, show, list } = registerAgentClassTools();

    const listed = (await list.execute("probe", {}, undefined, undefined, ctx)) as ToolResult;
    const agents = (listed.details as { agents?: Array<{ id: string }> })?.agents ?? [];
    expect(agents.length).toBeGreaterThan(0);

    const result = (await show.execute("call-1", { id: agents[0].id }, undefined, undefined, ctx)) as ToolResult;

    expect(result.isError, `fn_agent_show: ${result.content[0]?.text}`).toBeFalsy();
    expect(result.content[0]?.text).toContain(`ID: ${agents[0].id}`);
    expect(bootFactory).not.toHaveBeenCalled();
  });

  it("a cold-cache boot failure keeps its store attribution inside the fn_agent_show prefix", async () => {
    // The boot fails fast with the host-side cause a real stall produces, so the propagated tool
    // shape is proven without burning the 30 000 ms it would take to measure live.
    const rejecting = vi.fn(async () => {
      throw new Error("connection timed out after 20242ms (canceling statement due to lock timeout)");
    });
    __setExtensionStoreBootFactoryForTesting(rejecting as never);
    const { ctx, show } = registerAgentClassTools();

    // Force the cold path: drop the harness-injected (externally-owned) store so the resolver
    // must boot. closeCachedStores skips external entries, so the harness store itself survives.
    await closeCachedStores();

    const startedAt = Date.now();
    const result = (await show.execute("call-1", { id: "agent-48a5da4e" }, undefined, undefined, ctx)) as ToolResult;
    const text = result.content[0]?.text ?? "";

    expect(result.isError).toBe(true);
    // Attribution survives the wrapper: tool prefix + real store-boot cause, not a bare tool fault.
    expect(text).toMatch(/^fn_agent_show failed: /);
    expect(text).toContain("canceling statement due to lock timeout");
    expect(rejecting).toHaveBeenCalledTimes(1);

    // And the next agent call reads the backoff instead of re-paying: same reason, distinct shape.
    const second = (await show.execute("call-2", { id: "agent-48a5da4e" }, undefined, undefined, ctx)) as ToolResult;
    expect(second.content[0]?.text).toContain("fn extension TaskStore boot recently failed");
    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

/*
FNXC:TaskStoreBootAttribution 2026-09-28-08:55 (RUFU-388):
RUFU-377 spent its whole investigation looking for persisted `[taskstore-boot]` rows and found none,
because the machine never persists them: the runtime that hosts the extension forks it with
`silent: true` and forwards IPC alone, so a forked worker's stdout/stderr are piped and stored nowhere
(packages/engine/src/runtimes/child-process-runtime.ts). The JSDoc above `reportStoreBoot` nonetheless
promised a durable engine-side record, which is the false contract that cost that search its entire
attempt. The architecture doc already states the opposite invariant ("process-local console output, not
telemetry"). These are code-construct scans, not prose checks: the emission seam must stay exactly one
`console.warn` of the `[taskstore-boot]` line with no durable sink reachable from it.

FNXC:TestsAssertBehavior 2026-10-11-04:41 (RUFU-392):
This file used to carry a second arm beside the guard below — two `expect(extensionSource).not.toMatch(...)`
ratchets matching two sentence fragments of the `reportStoreBoot` JSDoc prose. That made comment wording a
test subject, which AGENTS.md ("Tests Assert Behavior, Never Source Text Or Comments") forbids: the cheapest
way to satisfy such an assertion is to re-add a sentence to shipped source for no reason but the assertion,
and the automated checker only flags `FNXC:` stamps inside matchers, so lint could not catch it. Both
ratchets are deleted, and this note deliberately describes them instead of quoting them — reproducing the
fragments here would leave this file grepping as a consumer of wording again, which is the defect class.
The console-only invariant the RUFU-377 search needed is covered honestly by the structural guard below — a
durable sink reachable from `reportStoreBoot` fails it — and review enforces the prose half of that rule.
*/
describe("reportStoreBoot's sink is console-only (RUFU-388)", () => {
  const extensionSource = readRepoFile("packages/cli/src/extension.ts");

  it("emits the boot line through console.warn and reaches no durable sink from it", () => {
    const body = extractFunctionBody(extensionSource, "function reportStoreBoot(");

    // The live emission is the whole contract: still present, still the same line prefix.
    expect(body).toContain("console.warn(");
    expect(body).toContain("[taskstore-boot] ");
    // A persisted sink reachable from here would contradict the invariant the comment now states.
    expect(body).not.toMatch(/recordRunAudit|emitBoundedRunAudit|appendFile|createWriteStream/);
  });
});

/*
FNXC:TaskStoreBootDeadline 2026-09-28-09:06 (RUFU-388):
The architecture doc's "Resolution order" bullet and the `getStore` seam had already drifted apart: the
doc listed cache → in-flight → cooldown → boot while the code consults the cache, then the failure
cooldown, then the shared in-flight boot. The transposition is not cosmetic — a cooldown window is the
only branch where the order is observable, and the doc's sequence promised that an agent-class call
landing during one would coalesce onto a sibling boot, while the code refuses it immediately with the
timeout-shaped cooldown sentence. A test asserting only the code order would have stayed green over the
wrong doc, so this guard compares the DOC's stage list against the occurrence order of the four registry
reads inside `getStore`. Either side being reordered turns it red.
*/
describe("the architecture doc states getStore's real resolution order (RUFU-388)", () => {
  /** Each doc stage name mapped to the registry read that implements it inside `getStore`. */
  const STAGE_CONSTRUCTS: Array<{ token: string; construct: string }> = [
    { token: "cache", construct: "storeCache.get(" },
    { token: "cooldown", construct: "storeBootFailureCooldown.get(" },
    { token: "in-flight", construct: "storeBootInflight.get(" },
    { token: "boot", construct: "startStoreBoot(" },
  ];

  /** The stage tokens exactly as the doc bullet lists them, left to right. */
  function docStageOrder(): string[] {
    const doc = readRepoFile("docs/architecture.md");
    const bullet = doc.match(/\*\*Resolution order is ([^*]+)\.\*\*/);
    expect(bullet, "docs/architecture.md must state the boot-budget resolution order bullet").not.toBeNull();
    return bullet![1]!
      .split("→")
      .map((stage) => stage.trim())
      .filter(Boolean);
  }

  /** The stages in the order `getStore` actually consults them, by first occurrence in its body. */
  function codeStageOrder(): string[] {
    const body = extractFunctionBody(readRepoFile("packages/cli/src/extension.ts"), "async function getStore(");
    const consulted = STAGE_CONSTRUCTS.map((stage) => ({ ...stage, at: body.indexOf(stage.construct) }));
    for (const stage of consulted) {
      expect(stage.at, `getStore must still consult ${stage.construct}`).toBeGreaterThanOrEqual(0);
    }
    return consulted
      .sort((a, b) => a.at - b.at)
      .map((stage) => stage.token);
  }

  it("names all four stages, so a renamed stage cannot vacuously pass", () => {
    expect(docStageOrder().slice().sort()).toEqual([...STAGE_CONSTRUCTS.map((s) => s.token)].sort());
  });

  it("lists the stages in the order getStore consults them", () => {
    expect(docStageOrder()).toEqual(codeStageOrder());
  });
});

/*
FNXC:CliTests 2026-09-28-09:30 (RUFU-388):
A host-absolute checkout path inside a test is invisible to every CI lane that runs on the machine it
names, and fails on the next one — which is how this file's old `TOOL_CALL_CWD` survived while breaking
the twelve registry arms off that host. The scan is scoped to THIS file alone: 87 files repo-wide still
carry a developer path, and a whole-repo ratchet would fail on all of them without naming this card's
change. The forbidden literals are assembled from fragments because a guard whose own source contained
the contiguous literal could never tell a real host path from the guard that forbids it.
*/
describe("this test file names no host path (RUFU-388)", () => {
  const SLASH = "/";
  const BACKSLASH = "\\";
  /** Interpolated, so this guard's source never contains the contiguous literal it hunts for. */
  const HOST_PATH_LITERALS = [
    `${SLASH}home${SLASH}`,
    `${SLASH}Users${SLASH}`,
    `C:${BACKSLASH}Users${BACKSLASH}`,
  ];

  function ownSource(): string {
    return readFileSync(join(import.meta.dirname, "extension-agent-class-boot-budget.test.ts"), "utf8");
  }

  it("contains no host home-directory path literal", () => {
    const source = ownSource();
    expect(source.length, "the guard must actually read its own source").toBeGreaterThan(0);
    expect(HOST_PATH_LITERALS.filter((literal) => source.includes(literal))).toEqual([]);
  });

  it("names a host path when one is present, so the scan is not vacuous", () => {
    const offendingSource = `const TOOL_CALL_CWD = "${SLASH}home${SLASH}dev${SLASH}repo";`;
    expect(HOST_PATH_LITERALS.filter((literal) => offendingSource.includes(literal))).toEqual([
      `${SLASH}home${SLASH}`,
    ]);
  });
});
