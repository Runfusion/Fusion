import { afterEach, describe, expect, it } from "vitest";
import type { PrEntity, Task, TaskStore } from "@fusion/core";
import {
  getTraitRegistry,
  __resetTraitRegistryForTests,
} from "@fusion/core";
import {
  TRIAGE_TRAIT_ID,
  TRIAGE_DEFAULT_ROUTE_COLUMN,
  TRIAGE_REVIEW_COLUMN,
  classifyTriageItem,
  resolveTriageSubject,
  registerTriageTrait,
  runTriageOnEnter,
  __resetTriageTraitForTests,
} from "../triage-trait.js";
import type { SubtaskItem } from "../subtask-breakdown.js";

// ── Fake store ──────────────────────────────────────────────────────────────

interface FakeStore extends TaskStore {
  _tasks: Task[];
  _prEntities: PrEntity[];
}

function makeStore(prEntities: PrEntity[] = []): FakeStore {
  const tasks: Task[] = [];
  let counter = 0;
  const store = {
    async createTask(input: Parameters<TaskStore["createTask"]>[0]) {
      const task = {
        id: `FN-${++counter}`,
        title: input.title,
        description: input.description,
        column: input.column,
        priority: input.priority,
        source: input.source,
      } as unknown as Task;
      tasks.push(task);
      return task;
    },
    async updateTask(
      id: string,
      updates: Parameters<TaskStore["updateTask"]>[1],
    ) {
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`task ${id} not found`);
      if (updates.priority !== undefined && updates.priority !== null) {
        task.priority = updates.priority;
      }
      const patch = (updates as { sourceMetadataPatch?: Record<string, unknown> })
        .sourceMetadataPatch;
      if (patch) {
        task.source = {
          sourceType: task.source?.sourceType ?? "api",
          ...task.source,
          sourceMetadata: { ...(task.source?.sourceMetadata ?? {}), ...patch },
        };
      }
      return task;
    },
    async moveTask(id: string, toColumn: string) {
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`task ${id} not found`);
      (task as { column: string }).column = toColumn;
      return task;
    },
    getPrEntity(id: string) {
      return prEntities.find((p) => p.id === id) ?? null;
    },
    getActivePrEntityBySource(sourceType: string, sourceId: string) {
      return (
        prEntities.find(
          (p) =>
            p.sourceType === sourceType &&
            p.sourceId === sourceId &&
            p.state !== "merged" &&
            p.state !== "closed",
        ) ?? null
      );
    },
    _tasks: tasks,
    _prEntities: prEntities,
  };
  return store as unknown as FakeStore;
}

function makeTask(partial: Partial<Task> & { id: string; description: string }): Task {
  return {
    column: "triage",
    ...partial,
  } as unknown as Task;
}

const decomposeTo =
  (items: Array<Partial<SubtaskItem>>) =>
  async (_d: string): Promise<SubtaskItem[]> =>
    items.map((it, i) => ({
      id: it.id ?? `subtask-${i + 1}`,
      title: it.title ?? `Sub ${i + 1}`,
      description: it.description ?? "",
      suggestedSize: it.suggestedSize ?? "M",
      priority: it.priority,
      dependsOn: it.dependsOn ?? [],
    }));

afterEach(() => {
  __resetTriageTraitForTests();
  __resetTraitRegistryForTests();
});

// ── classification ──────────────────────────────────────────────────────────

describe("classifyTriageItem", () => {
  it("classifies a dependency bump PR", () => {
    const c = classifyTriageItem({
      kind: "pull_request",
      title: "Bump lodash from 4.17.20 to 4.17.21",
      prAuthor: "dependabot[bot]",
    });
    expect(c.dependencyBump).toBe(true);
    expect(c.area).toBe("dependency");
    expect(c.labels).toContain("automated");
  });

  it("classifies a feature PR as not a dependency bump", () => {
    const c = classifyTriageItem({
      kind: "pull_request",
      title: "Add dark mode support",
      prAuthor: "contributor",
    });
    expect(c.dependencyBump).toBe(false);
    expect(c.area).toBe("feature");
  });

  it("maps critical severity to urgent priority", () => {
    const c = classifyTriageItem({ kind: "signal", title: "DB down", severity: "critical" });
    expect(c.priority).toBe("urgent");
    expect(c.labels).toContain("signal");
  });
});

// ── PR-vs-issue + self-loop guard ────────────────────────────────────────────

describe("resolveTriageSubject", () => {
  it("treats a signal-sourced task as a triageable signal", () => {
    const task = makeTask({
      id: "FN-1",
      description: "err",
      source: { sourceType: "api", sourceMetadata: { signalSource: "sentry" } },
    });
    const subj = resolveTriageSubject(task);
    expect(subj.kind).toBe("signal");
    expect(subj.triageable).toBe(true);
  });

  it("treats an inbound PR with no Fusion entity as triageable", () => {
    const task = makeTask({
      id: "FN-2",
      description: "pr",
      source: { sourceType: "api", sourceMetadata: { resourceType: "pr", prInbound: true } },
    });
    const subj = resolveTriageSubject(task, makeStore());
    expect(subj.kind).toBe("pull_request");
    expect(subj.triageable).toBe(true);
  });

  it("does NOT triage a PR Fusion itself opened (owned by a task PrEntity)", () => {
    const store = makeStore([
      {
        id: "PR-1",
        sourceType: "task",
        sourceId: "FN-3",
        repo: "o/r",
        headBranch: "feat",
        state: "open",
      } as unknown as PrEntity,
    ]);
    const task = makeTask({
      id: "FN-3",
      description: "pr",
      source: { sourceType: "api", sourceMetadata: { resourceType: "pr", prInbound: true } },
    });
    const subj = resolveTriageSubject(task, store);
    expect(subj.kind).toBe("pull_request");
    expect(subj.triageable).toBe(false);
    expect(subj.skipReason).toContain("self-loop");
  });

  it("does NOT triage a PR not marked inbound", () => {
    const task = makeTask({
      id: "FN-4",
      description: "pr",
      source: { sourceType: "api", sourceMetadata: { resourceType: "pr" } },
    });
    const subj = resolveTriageSubject(task, makeStore());
    expect(subj.triageable).toBe(false);
  });
});

// ── runTriageOnEnter scenarios ───────────────────────────────────────────────

describe("runTriageOnEnter", () => {
  it("decomposes a signal task into N todo tasks linked to the signal", async () => {
    const store = makeStore();
    const signal = makeTask({
      id: "FN-10",
      title: "Outage report",
      description: "Investigate the production outage and fix the root cause",
      source: { sourceType: "api", sourceMetadata: { signalSource: "sentry", signalSeverity: "error" } },
    });
    store._tasks.push(signal);

    const outcome = await runTriageOnEnter(signal, {
      store,
      decompose: decomposeTo([{ title: "Diagnose" }, { title: "Fix" }, { title: "Verify" }]),
    });

    expect(outcome.kind).toBe("decomposed");
    if (outcome.kind !== "decomposed") throw new Error("unreachable");
    expect(outcome.childTaskIds).toHaveLength(3);
    expect(outcome.routedColumn).toBe(TRIAGE_DEFAULT_ROUTE_COLUMN);
    // children created in todo, linked back to the signal
    const children = store._tasks.filter((t) => outcome.childTaskIds.includes(t.id));
    for (const c of children) {
      expect(c.column).toBe("todo");
      expect(c.source?.sourceParentTaskId).toBe("FN-10");
      expect((c.source?.sourceMetadata as Record<string, unknown>).triageParentTaskId).toBe("FN-10");
    }
    // signal stamped as triaged
    expect((signal.source?.sourceMetadata as Record<string, unknown>).triageProcessedAt).toBeTruthy();
  });

  it("passes a too-small signal through as a SINGLE task (not zero)", async () => {
    const store = makeStore();
    const signal = makeTask({
      id: "FN-11",
      title: "Tiny",
      description: "trivial one-liner",
      source: { sourceType: "api", sourceMetadata: { signalSource: "webhook" } },
    });
    store._tasks.push(signal);

    const outcome = await runTriageOnEnter(signal, {
      store,
      decompose: decomposeTo([{ title: "Only one" }]),
    });

    expect(outcome.kind).toBe("passthrough");
    if (outcome.kind !== "passthrough") throw new Error("unreachable");
    expect(outcome.taskId).toBe("FN-11");
    expect(outcome.routedColumn).toBe("todo");
    expect(signal.column).toBe("todo");
    // no children minted
    expect(store._tasks).toHaveLength(1);
  });

  it("routes a dependency-bump PR to review (no issue minted)", async () => {
    const store = makeStore();
    const pr = makeTask({
      id: "FN-12",
      title: "Bump express from 4.18.0 to 4.18.2",
      description: "dependabot bump",
      source: {
        sourceType: "api",
        sourceMetadata: { resourceType: "pr", prInbound: true, prAuthor: "dependabot[bot]" },
      },
    });
    store._tasks.push(pr);

    const outcome = await runTriageOnEnter(pr, { store });

    expect(outcome.kind).toBe("pr-review");
    expect(pr.column).toBe(TRIAGE_REVIEW_COLUMN);
    // exactly one task (the PR itself); no follow-up, no issue
    expect(store._tasks).toHaveLength(1);
  });

  it("opens a follow-up task for a feature PR linked to its PR entity", async () => {
    const store = makeStore();
    const pr = makeTask({
      id: "FN-13",
      title: "Add new export format",
      description: "feature PR from external contributor",
      source: {
        sourceType: "api",
        sourceMetadata: { resourceType: "pr", prInbound: true, prEntityId: "PR-99" },
      },
    });
    store._tasks.push(pr);

    const outcome = await runTriageOnEnter(pr, { store });

    expect(outcome.kind).toBe("pr-follow-up");
    if (outcome.kind !== "pr-follow-up") throw new Error("unreachable");
    expect(pr.column).toBe(TRIAGE_REVIEW_COLUMN);
    const followUp = store._tasks.find((t) => t.id === outcome.followUpTaskId);
    expect(followUp).toBeDefined();
    expect(followUp!.source?.sourceParentTaskId).toBe("FN-13");
    expect((followUp!.source?.sourceMetadata as Record<string, unknown>).prEntityId).toBe("PR-99");
  });

  it("does NOT re-triage a PR Fusion itself opened (no self-loop)", async () => {
    const store = makeStore([
      {
        id: "PR-1",
        sourceType: "task",
        sourceId: "FN-14",
        repo: "o/r",
        headBranch: "feat",
        state: "open",
      } as unknown as PrEntity,
    ]);
    const pr = makeTask({
      id: "FN-14",
      title: "feat: my own change",
      description: "PR Fusion opened",
      column: "triage",
      source: { sourceType: "api", sourceMetadata: { resourceType: "pr", prInbound: true } },
    });
    store._tasks.push(pr);

    const outcome = await runTriageOnEnter(pr, { store });

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toContain("self-loop");
    // no follow-up created, PR not moved out of triage
    expect(store._tasks).toHaveLength(1);
    expect(pr.column).toBe("triage");
  });

  it("PARKS the item in triage on classifier/decompose failure (does not drop it)", async () => {
    const store = makeStore();
    const signal = makeTask({
      id: "FN-15",
      title: "Boom",
      description: "will fail to decompose",
      source: { sourceType: "api", sourceMetadata: { signalSource: "sentry" } },
    });
    store._tasks.push(signal);

    const outcome = await runTriageOnEnter(signal, {
      store,
      decompose: async () => {
        throw new Error("classifier exploded");
      },
    });

    expect(outcome.kind).toBe("parked");
    if (outcome.kind !== "parked") throw new Error("unreachable");
    expect(outcome.reason).toContain("classifier exploded");
    // still in triage, marker recorded, not dropped
    expect(signal.column).toBe("triage");
    expect(store._tasks).toHaveLength(1);
    expect((signal.source?.sourceMetadata as Record<string, unknown>).triageError).toContain(
      "classifier exploded",
    );
  });

  it("is idempotent: an already-triaged task is a no-op skip", async () => {
    const store = makeStore();
    const signal = makeTask({
      id: "FN-16",
      title: "done already",
      description: "x",
      source: {
        sourceType: "api",
        sourceMetadata: { signalSource: "sentry", triageProcessedAt: "2026-01-01T00:00:00Z" },
      },
    });
    store._tasks.push(signal);

    const outcome = await runTriageOnEnter(signal, { store, decompose: decomposeTo([{}, {}]) });
    expect(outcome.kind).toBe("skipped");
    expect(store._tasks).toHaveLength(1);
  });
});

// ── registry wiring ──────────────────────────────────────────────────────────

describe("registerTriageTrait", () => {
  it("registers a triage trait with an onEnter hook resolvable through the registry", async () => {
    __resetTraitRegistryForTests();
    __resetTriageTraitForTests();
    registerTriageTrait();

    const registry = getTraitRegistry();
    const def = registry.getTrait(TRIAGE_TRAIT_ID);
    expect(def).toBeDefined();
    expect(def!.builtin).toBe(true);
    expect(def!.hooks?.onEnter).toBe(true);

    const resolved = registry.resolveTraitHook(TRIAGE_TRAIT_ID, "onEnter");
    expect(resolved.warning).toBeUndefined();
    expect(typeof resolved.impl).toBe("function");

    // The resolved impl runs the triage pass against the ctx-supplied deps.
    const store = makeStore();
    const signal = makeTask({
      id: "FN-20",
      title: "via hook",
      description: "decompose me",
      source: { sourceType: "api", sourceMetadata: { signalSource: "sentry" } },
    });
    store._tasks.push(signal);

    const result = await resolved.impl!({
      task: signal,
      deps: { store, decompose: decomposeTo([{}, {}, {}]) },
    });
    expect((result as { kind: string }).kind).toBe("decomposed");
  });
});
