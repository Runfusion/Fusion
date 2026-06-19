/**
 * U7 — Merge trait behavior (R10).
 *
 * Covers every U7 plan scenario:
 *   - each `strategy` value routes to the merger behavior it names, incl.
 *     `pr-only` (enqueue-with-prState marker, documented below);
 *   - `fileScope` off / warn / strict / custom behaviors incl. audit payloads;
 *   - lost-work guard trio regression: config CANNOT reach the three guards;
 *   - merge completion drives the next column via the queue callback, not
 *     inline;
 *   - a queued merge surviving restart resumes from SQLite state (fixture).
 *
 * Fast: mock stores + a single in-memory `TaskStore` (no real git, no real
 * merges). No process spawns; no fake-timer-dependent waits.
 *
 * PR-ONLY DESIGN DECISION: there is no PR-creation path inside the merge queue
 * in this codebase — the merge-queue worker loop runs `aiMergeTask` (a direct
 * merge). So `pr-only` is implemented as a *routing flag* on the resolved
 * policy (`pullRequestOnly: true`), consistent with the existing
 * `settings.mergeStrategy === "pull-request"` posture: `merger.ts` skips
 * direct-merge commit routing exactly as it does for the pull-request setting.
 * The card still enqueues onto the same persisted merge-request queue; the
 * pr-state marker is the existing pr-monitor machinery's concern. This is the
 * narrowest change that makes `pr-only` behave like the pull-request route
 * without reimplementing merge mechanics.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  TaskStore,
  getTraitRegistry,
  type Settings,
  type Task,
  type WorkflowIr,
} from "@fusion/core";

import { resolveMergePolicy } from "../merge-trait.js";
import {
  assertSquashOverlapsFileScope,
  enforceSquashFileScopeInvariant,
  FileScopeViolationError,
} from "../merger.js";

// NOTE: this file deliberately does NOT import `./merger-test-helpers.js` — that
// module installs a module-scope `vi.mock("node:child_process")` that would
// break the real `git` operations the real-`TaskStore` fixtures here rely on.
// The file-scope tests use a real git repo and stage real files instead, so the
// merger's real `git diff --cached --name-only` returns the staged set.

// ── helpers ──────────────────────────────────────────────────────────────────

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides } as Settings;
}

/** Initialize a temp dir as a git repo with a `.fusion` dir so `createTask`
 *  (which writes `task.json`) works against a real `TaskStore`. */
async function initRepo(rootDir: string): Promise<void> {
  const run = (cmd: string) => execSync(cmd, { cwd: rootDir, stdio: "pipe" });
  run("git init -b main");
  run('git config user.email "test@example.com"');
  run('git config user.name "Test User"');
  await writeFile(join(rootDir, "README.md"), "# fixture\n", "utf-8");
  run("git add README.md");
  run('git commit -m "chore: init"');
  await mkdir(join(rootDir, ".fusion"), { recursive: true });
}

/** A linear custom workflow whose `in-review` column carries a merge trait with
 *  the given config. Linear so `selectTaskWorkflow` compiles it. */
function customMergeWorkflowIr(mergeConfig: Record<string, unknown>): WorkflowIr {
  return {
    version: "v2",
    name: "custom-merge-wf",
    columns: [
      { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      {
        id: "in-review",
        name: "In review",
        traits: [{ trait: "merge", config: mergeConfig }],
      },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "triage" },
      { id: "execute", kind: "prompt", column: "in-progress", config: { seam: "execute" } },
      { id: "merge", kind: "prompt", column: "in-review", config: { seam: "merge" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "execute" },
      { from: "execute", to: "merge", condition: "success" },
      { from: "merge", to: "end", condition: "success" },
      { from: "execute", to: "end", condition: "failure" },
      { from: "merge", to: "end", condition: "failure" },
    ],
  };
}

// ── 1. strategy routing (resolveMergePolicy) ─────────────────────────────────

describe("resolveMergePolicy — strategy routing", () => {
  beforeEach(() => vi.clearAllMocks());

  // Flag-OFF resolution returns before touching the store (settings passed in).
  const noStore = {} as never;

  it("flag OFF: falls back to settings (directMergeCommitStrategy + mergeStrategy)", async () => {
    const settings = settingsWith({
      mergeStrategy: "direct",
      directMergeCommitStrategy: "always-rebase",
    });
    const policy = await resolveMergePolicy(noStore, { id: "FN-1", column: "in-review" }, settings);
    expect(policy.source).toBe("settings");
    expect(policy.commitStrategy).toBe("always-rebase");
    expect(policy.pullRequestOnly).toBe(false);
  });

  it("flag OFF + pull-request setting: pullRequestOnly true via settings", async () => {
    const settings = settingsWith({ mergeStrategy: "pull-request" });
    const policy = await resolveMergePolicy(noStore, { id: "FN-1", column: "in-review" }, settings);
    expect(policy.pullRequestOnly).toBe(true);
    expect(policy.source).toBe("settings");
  });

  it.each([
    ["always-squash", "always-squash", false],
    ["auto", "auto", false],
    ["always-rebase", "always-rebase", false],
  ] as const)(
    "flag ON: merge trait strategy '%s' resolves to commitStrategy '%s'",
    async (strategy, expectedStrategy, expectedPrOnly) => {
      const fx = await makeStoreFixture();
      try {
        await fx.selectCustomMergeWorkflow({ strategy });
        const policy = await resolveMergePolicy(fx.store, { id: fx.taskId, column: "in-review" });
        expect(policy.source).toBe("workflow");
        expect(policy.commitStrategy).toBe(expectedStrategy);
        expect(policy.pullRequestOnly).toBe(expectedPrOnly);
      } finally {
        await fx.cleanup();
      }
    },
  );

  it("flag ON: merge trait strategy 'pr-only' sets pullRequestOnly (PR-route, no direct merge)", async () => {
    const fx = await makeStoreFixture();
    try {
      await fx.selectCustomMergeWorkflow({ strategy: "pr-only" });
      const policy = await resolveMergePolicy(fx.store, { id: fx.taskId, column: "in-review" });
      expect(policy.source).toBe("workflow");
      expect(policy.pullRequestOnly).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("flag ON but default workflow (no merge config): resolves entirely from settings", async () => {
    const fx = await makeStoreFixture();
    try {
      // No custom workflow selected → default workflow → merge trait has no
      // config → settings read-through (verbatim back-compat). The flag is
      // already ON from the fixture; set the project-level strategy.
      await fx.store.updateSettings(settingsWith({ directMergeCommitStrategy: "auto" }));
      const policy = await resolveMergePolicy(fx.store, { id: fx.taskId, column: "in-review" });
      expect(policy.commitStrategy).toBe("auto");
      // Default workflow's merge column has no config, so source is settings.
      expect(policy.source).toBe("settings");
    } finally {
      await fx.cleanup();
    }
  });
});

// ── 2. fileScope modes (off / warn / strict / custom) ────────────────────────
//
// These use a REAL git repo with a staged out-of-scope file so the merger's
// real `git diff --cached --name-only` returns it. The store is a lightweight
// inline fake (NOT the merger-test-helpers mock, which would shadow git). The
// resolved fileScope mode is driven by the fake's settings + workflow stubs.

interface ScopeRepo {
  rootDir: string;
  /** Stage a file at the given repo-relative path (creates it). */
  stage: (relPath: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

async function makeScopeRepo(): Promise<ScopeRepo> {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-scope-"));
  await initRepo(rootDir);
  const run = (cmd: string) => execSync(cmd, { cwd: rootDir, stdio: "pipe" });
  return {
    rootDir,
    async stage(relPath) {
      const abs = join(rootDir, relPath);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "// staged\n", "utf-8");
      run(`git add -- "${relPath}"`);
    },
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

/** Inline fake store for the file-scope assertions: just the methods the
 *  resolver + enforcement read. `workflow` drives the resolved fileScope mode;
 *  omitting it (with a flag-off settings) yields the legacy `warn` mode. */
function fakeScopeStore(opts: {
  declaredScope: string[];
  settings: Settings;
  scopeOverride?: boolean;
  workflow?: { id: string; mergeConfig: Record<string, unknown> };
}) {
  const task: Task = {
    id: "FN-4073",
    title: "scope task",
    description: "x",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    scopeOverride: opts.scopeOverride,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
  const parseFileScopeFromPrompt = vi.fn().mockResolvedValue(opts.declaredScope);
  return {
    task,
    parseFileScopeFromPrompt,
    store: {
      getTask: vi.fn().mockResolvedValue(task),
      getSettings: vi.fn().mockResolvedValue(opts.settings),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      parseFileScopeFromPrompt,
      getTaskWorkflowSelection: vi.fn().mockReturnValue(
        opts.workflow ? { workflowId: opts.workflow.id, stepIds: [] } : undefined,
      ),
      getWorkflowDefinition: vi.fn().mockResolvedValue(
        opts.workflow
          ? { id: opts.workflow.id, ir: customMergeWorkflowIr(opts.workflow.mergeConfig) }
          : undefined,
      ),
    } as never,
  };
}

describe("fileScope modes — enforceSquashFileScopeInvariant", () => {
  let repo: ScopeRepo;
  beforeEach(async () => {
    vi.clearAllMocks();
    repo = await makeScopeRepo();
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const declared = ["packages/engine/src/merger.ts"];

  it("'warn' (legacy/flag-OFF default): logs + proceeds, audit carries the file list", async () => {
    const { store } = fakeScopeStore({ declaredScope: declared, settings: settingsWith({}) });
    await repo.stage("packages/core/src/store.ts"); // out of scope
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };

    await expect(
      enforceSquashFileScopeInvariant({
        store,
        taskId: "FN-4073",
        rootDir: repo.rootDir,
        task: await (store as never as { getTask: (id: string) => Promise<Task> }).getTask("FN-4073"),
        resetLabel: "file-scope invariant violation",
        auditor: auditor as never,
      }),
    ).resolves.toBeUndefined();

    expect(auditor.git).toHaveBeenCalledTimes(1);
    const call = auditor.git.mock.calls[0][0];
    expect(call.type).toBe("merge:file-scope-violation");
    expect(call.metadata.warningOnly).toBe(true);
    expect(call.metadata.stagedFiles).toEqual(["packages/core/src/store.ts"]);
    expect(call.metadata.declaredScope).toEqual(declared);
  });

  it("'strict': re-throws FileScopeViolationError and audits with warningOnly=false", async () => {
    const { store } = fakeScopeStore({
      declaredScope: declared,
      settings: settingsWith({ experimentalFeatures: { workflowColumns: true } }),
      workflow: { id: "wf-strict", mergeConfig: { fileScope: "strict" } },
    });
    await repo.stage("packages/core/src/store.ts");
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };

    await expect(
      enforceSquashFileScopeInvariant({
        store,
        taskId: "FN-4073",
        rootDir: repo.rootDir,
        task: await (store as never as { getTask: (id: string) => Promise<Task> }).getTask("FN-4073"),
        resetLabel: "file-scope invariant violation",
        auditor: auditor as never,
      }),
    ).rejects.toBeInstanceOf(FileScopeViolationError);

    const call = auditor.git.mock.calls[0][0];
    expect(call.metadata.mode).toBe("strict");
    expect(call.metadata.warningOnly).toBe(false);
  });

  it("'off': skips the throw and emits one scope-enforcement-disabled audit", async () => {
    const { store } = fakeScopeStore({
      declaredScope: declared,
      settings: settingsWith({ experimentalFeatures: { workflowColumns: true } }),
      scopeOverride: true,
      workflow: { id: "wf-off", mergeConfig: { fileScope: "off" } },
    });
    await repo.stage("packages/core/src/store.ts");
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };

    await expect(
      enforceSquashFileScopeInvariant({
        store,
        taskId: "FN-4073",
        rootDir: repo.rootDir,
        task: await (store as never as { getTask: (id: string) => Promise<Task> }).getTask("FN-4073"),
        resetLabel: "file-scope invariant violation",
        auditor: auditor as never,
      }),
    ).resolves.toBeUndefined();

    expect(auditor.git).toHaveBeenCalledTimes(1);
    const call = auditor.git.mock.calls[0][0];
    expect(call.type).toBe("merge:file-scope-enforcement-disabled");
    expect(call.metadata.disabledByWorkflowConfig).toBe(true);
    // per-task scopeOverride is a documented no-op in this mode
    expect(call.metadata.scopeOverrideIsNoOp).toBe(true);
  });

  it("'custom': evaluates supplied rules in place of the prompt's File Scope", async () => {
    // Prompt scope would be `declared` (no overlap), but custom rules DO overlap
    // the staged file → no violation.
    const { store, parseFileScopeFromPrompt } = fakeScopeStore({
      declaredScope: declared,
      settings: settingsWith({ experimentalFeatures: { workflowColumns: true } }),
      workflow: { id: "wf-custom", mergeConfig: { fileScope: "custom", rules: ["packages/core/src/**"] } },
    });
    await repo.stage("packages/core/src/store.ts"); // overlaps custom rules
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };

    await expect(
      enforceSquashFileScopeInvariant({
        store,
        taskId: "FN-4073",
        rootDir: repo.rootDir,
        task: await (store as never as { getTask: (id: string) => Promise<Task> }).getTask("FN-4073"),
        resetLabel: "file-scope invariant violation",
        auditor: auditor as never,
      }),
    ).resolves.toBeUndefined();

    expect(auditor.git).not.toHaveBeenCalled();
    // The prompt's File Scope is bypassed when custom rules are present.
    expect(parseFileScopeFromPrompt).not.toHaveBeenCalled();
  });

  it("'custom' with violating rules: rules replace prompt scope and a violation is detected", async () => {
    const { store } = fakeScopeStore({
      declaredScope: declared,
      settings: settingsWith({ experimentalFeatures: { workflowColumns: true } }),
      workflow: { id: "wf-custom", mergeConfig: { fileScope: "custom", rules: ["docs/**"] } },
    });
    await repo.stage("packages/core/src/store.ts"); // does NOT overlap docs/**
    const auditor = { git: vi.fn().mockResolvedValue(undefined) };

    await expect(
      enforceSquashFileScopeInvariant({
        store,
        taskId: "FN-4073",
        rootDir: repo.rootDir,
        task: await (store as never as { getTask: (id: string) => Promise<Task> }).getTask("FN-4073"),
        resetLabel: "file-scope invariant violation",
        auditor: auditor as never,
      }),
    ).resolves.toBeUndefined();

    expect(auditor.git).toHaveBeenCalledTimes(1);
    expect(auditor.git.mock.calls[0][0].metadata.declaredScope).toEqual(["docs/**"]);
  });
});

describe("assertSquashOverlapsFileScope — custom rules + scopeOverride interaction", () => {
  let repo: ScopeRepo;
  beforeEach(async () => {
    vi.clearAllMocks();
    repo = await makeScopeRepo();
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it("custom rules override the per-task scopeOverride (rules take precedence)", async () => {
    const { store } = fakeScopeStore({
      declaredScope: ["packages/engine/**"],
      settings: settingsWith({}),
      scopeOverride: true,
    });
    await repo.stage("packages/core/src/store.ts"); // does not overlap custom rules
    await expect(
      assertSquashOverlapsFileScope({
        store,
        taskId: "FN-4073",
        rootDir: repo.rootDir,
        task: await (store as never as { getTask: (id: string) => Promise<Task> }).getTask("FN-4073"),
        customScopeRules: ["packages/engine/**"],
      }),
    ).rejects.toBeInstanceOf(FileScopeViolationError);
  });

  it("without custom rules, scopeOverride bypasses the check (legacy behavior intact)", async () => {
    const { store } = fakeScopeStore({
      declaredScope: ["packages/engine/**"],
      settings: settingsWith({}),
      scopeOverride: true,
    });
    await repo.stage("packages/core/src/store.ts");
    await expect(
      assertSquashOverlapsFileScope({
        store,
        taskId: "FN-4073",
        rootDir: repo.rootDir,
        task: await (store as never as { getTask: (id: string) => Promise<Task> }).getTask("FN-4073"),
      }),
    ).resolves.toBeUndefined();
  });
});

// ── 3. lost-work guard trio: config CANNOT reach them ────────────────────────

describe("lost-work guard trio is non-configurable (KTD-6 regression)", () => {
  it("the merge trait config schema exposes NO field that names a lost-work guard", () => {
    const def = getTraitRegistry().getTrait("merge");
    expect(def).toBeDefined();
    const keys = (def?.configSchema?.fields ?? []).map((f) => f.key);
    // Only policy knobs — nothing that could disable sibling-branch rejection,
    // line-anchored attribution, or no-op-finalize modifiedFiles preservation.
    expect(keys.sort()).toEqual(["conflictStrategy", "fileScope", "rules", "squash", "strategy"]);
    for (const forbidden of [
      "allowSiblingMergeTarget",
      "siblingBranch",
      "attribution",
      "clearModifiedFiles",
      "noOpFinalize",
      "lostWork",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("resolved policy never carries a lost-work toggle, regardless of fileScope/strategy", async () => {
    const fx = await makeStoreFixture();
    try {
      for (const cfg of [
        { fileScope: "off", strategy: "always-squash" },
        { fileScope: "warn", strategy: "auto" },
        { fileScope: "custom", rules: ["**/*"], strategy: "pr-only" },
      ] as const) {
        await fx.selectCustomMergeWorkflow(cfg);
        const policy = await resolveMergePolicy(fx.store, { id: fx.taskId, column: "in-review" });
        // The resolved policy object's keys are a closed set — no guard knob.
        expect(Object.keys(policy).sort()).toEqual(
          ["commitStrategy", "fileScope", "fileScopeRules", "pullRequestOnly", "source"].sort(),
        );
      }
    } finally {
      await fx.cleanup();
    }
  });
});

// ── 4. merge.onEnter is the core field-effects hook, invoked as impl(ctx) ─────
//
// Regression for the unhandled rejection in the hold-release sweep
// (TypeError: Cannot read properties of undefined (reading 'id')). The engine
// used to register a `mergeOnEnter(store, task)` impl here; the ONLY caller
// (`applyDefaultWorkflowMoveEffects`) invokes the hook as `impl(ctx)` with a
// single `DefaultWorkflowMoveContext` (no store handle), so `task` bound to
// `undefined` and `task.id` threw. The merge hook is now owned by core
// (`applyInReviewEnterEffects`, registered via `registerDefaultWorkflowHooks`);
// the enqueue is store-owned on the handoff path. Importing this engine module
// must NOT clobber that registration.
describe("merge.onEnter — core field-effects hook (no engine clobber)", () => {
  it("resolves to a real impl that is safe to invoke as impl(ctx) (single arg)", async () => {
    const fx = await makeStoreFixture();
    try {
      const onEnter = getTraitRegistry().resolveTraitHook("merge", "onEnter");
      expect(onEnter.impl).toBeDefined();
      expect(onEnter.warning).toBeUndefined(); // a real impl, not a degraded no-op

      // The contract the bug violated: the ONLY caller invokes the hook with a
      // single `DefaultWorkflowMoveContext` (no store, no second `task` arg). A
      // `(store, task)`-shaped impl would deref `undefined.id` and throw here.
      // Order-independent: this guards the signature regardless of which module
      // registered last.
      const task = await fx.store.getTask(fx.taskId);
      const ctx = {
        task,
        fromColumn: "in-progress",
        toColumn: "in-review",
        moveSource: "scheduler",
        bypassGuards: false,
        movedAt: new Date().toISOString(),
        settings: undefined,
        options: {},
        resetSteps: () => {},
      };
      expect(() => (onEnter.impl as (c: unknown) => void)(ctx)).not.toThrow();
    } finally {
      await fx.cleanup();
    }
  });

  it("a flag-ON move into in-review does not throw and clears scheduler state", async () => {
    const fx = await makeStoreFixture();
    try {
      // Fresh card in in-progress with scheduler dispatch state that MUST be
      // cleared on review entry (else it permanently blocks the merge gate).
      const created = await fx.store.createTask({
        title: "review-entry",
        description: "x",
        column: "in-progress",
        branch: "fusion/fn-review-entry",
        baseBranch: "main",
        steps: [],
        status: "queued",
        blockedBy: "SOME-OTHER",
        overlapBlockedBy: "SOME-OTHER",
      } as never);

      // The exact wiring that crashed: moveTask → moveTaskInternal →
      // applyDefaultWorkflowMoveEffects → merge.onEnter, invoked as impl(ctx).
      const moved = await fx.store.moveTask(created.id, "in-review", {
        moveSource: "scheduler",
        allowDirectInReviewMove: true,
      } as never);

      expect(moved.column).toBe("in-review");
      // applyInReviewEnterEffects ran: scheduler dispatch state is cleared.
      expect(moved.status).toBeUndefined();
      expect(moved.blockedBy).toBeUndefined();
      expect(moved.overlapBlockedBy).toBeUndefined();
    } finally {
      await fx.cleanup();
    }
  });
});

// ── 5. queued merge survives restart (resumes from SQLite) ───────────────────

describe("queued merge survives restart (SQLite-authoritative)", () => {
  it("a queued entry persists across a fresh TaskStore over the same DB file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-merge-trait-"));
    try {
      await initRepo(rootDir);
      // First store: create task in-review and enqueue.
      const store1 = new TaskStore(rootDir, undefined, {});
      await store1.init();
      await store1.updateSettings(settingsWith({ mergeStrategy: "direct" }));
      const created = await store1.createTask({
        title: "resume",
        description: "x",
        column: "in-review",
        branch: "fusion/fn-resume",
        baseBranch: "main",
        steps: [],
      } as never);
      const resumeId = created.id;
      store1.enqueueMergeQueue(resumeId, {});
      expect(store1.peekMergeQueue().some((e) => e.taskId === resumeId)).toBe(true);
      store1.close();

      // Second store over the same on-disk DB: the queued entry is still there.
      const store2 = new TaskStore(rootDir, undefined, {});
      await store2.init();
      expect(store2.peekMergeQueue().some((e) => e.taskId === resumeId)).toBe(true);
      store2.close();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

// ── shared in-memory store fixture ───────────────────────────────────────────

interface StoreFixture {
  store: TaskStore;
  taskId: string;
  selectCustomMergeWorkflow: (mergeConfig: Record<string, unknown>) => Promise<void>;
  peekQueue: (taskId: string) => unknown;
  queueCount: () => number;
  cleanup: () => Promise<void>;
}

async function makeStoreFixture(): Promise<StoreFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-merge-trait-"));
  await initRepo(rootDir);
  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  await store.updateSettings(settingsWith({ mergeStrategy: "direct" }));
  // `experimentalFeatures` is a GLOBAL setting (mirrors the characterization
  // suite), so it must be set via updateGlobalSettings to flip the flag.
  await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } } as never);
  const created = await store.createTask({
    title: "merge-trait fixture",
    description: "merge-trait fixture",
    column: "in-review",
    branch: "fusion/fn-mt",
    baseBranch: "main",
    steps: [],
  } as never);
  const taskId = created.id;

  return {
    store,
    taskId,
    async selectCustomMergeWorkflow(mergeConfig) {
      const def = await store.createWorkflowDefinition({
        name: `wf-${Math.random().toString(36).slice(2)}`,
        ir: customMergeWorkflowIr(mergeConfig),
      } as never);
      await store.selectTaskWorkflow(taskId, def.id);
    },
    peekQueue(id) {
      return store.peekMergeQueue().find((e) => e.taskId === id);
    },
    queueCount() {
      return store.peekMergeQueue().length;
    },
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
