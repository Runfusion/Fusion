import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflectionStore } from "./reflection-store.js";
import type { AgentReflection, ReflectionTrigger } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-reflection-store-test-"));
}

function makeReflection(
  agentId: string,
  overrides: Partial<AgentReflection> = {},
): AgentReflection {
  return {
    id: `reflection-${Math.random().toString(16).slice(2, 10)}`,
    agentId,
    timestamp: new Date().toISOString(),
    trigger: "manual",
    metrics: {},
    insights: [],
    suggestedImprovements: [],
    summary: "summary",
    ...overrides,
  };
}

describe("ReflectionStore", () => {
  let rootDir: string;
  let store: ReflectionStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new ReflectionStore({ rootDir });
    await store.init();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates the agents/ directory inside rootDir", async () => {
      const agentsDir = join(rootDir, "agents");
      expect(existsSync(agentsDir)).toBe(true);
    });

    it("is idempotent", async () => {
      await store.init();
      await store.init();
      expect(existsSync(join(rootDir, "agents"))).toBe(true);
    });
  });

  describe("createReflection", () => {
    it("creates a reflection with expected fields", async () => {
      const reflection = await store.createReflection({
        agentId: "agent-001",
        trigger: "post-task",
        triggerDetail: "after task FN-042 completion",
        taskId: "FN-042",
        metrics: { tasksCompleted: 1, avgDurationMs: 4200 },
        insights: ["Strong planning reduced context switching"],
        suggestedImprovements: ["Improve edge-case validation"],
        summary: "Solid execution with one validation gap.",
      });

      expect(reflection.id).toMatch(/^reflection-/);
      expect(reflection.agentId).toBe("agent-001");
      expect(reflection.trigger).toBe("post-task");
      expect(reflection.triggerDetail).toBe("after task FN-042 completion");
      expect(reflection.taskId).toBe("FN-042");
      expect(reflection.metrics).toEqual({ tasksCompleted: 1, avgDurationMs: 4200 });
      expect(reflection.insights).toEqual(["Strong planning reduced context switching"]);
      expect(reflection.suggestedImprovements).toEqual(["Improve edge-case validation"]);
      expect(reflection.summary).toBe("Solid execution with one validation gap.");
      expect(Number.isNaN(Date.parse(reflection.timestamp))).toBe(false);
    });

    it("generates unique reflection IDs", async () => {
      const first = await store.createReflection({
        agentId: "agent-001",
        trigger: "manual",
        metrics: {},
        insights: [],
        suggestedImprovements: [],
        summary: "first",
      });
      const second = await store.createReflection({
        agentId: "agent-001",
        trigger: "manual",
        metrics: {},
        insights: [],
        suggestedImprovements: [],
        summary: "second",
      });

      expect(first.id).toMatch(/^reflection-/);
      expect(second.id).toMatch(/^reflection-/);
      expect(first.id).not.toBe(second.id);
    });

    it("appends reflections to the JSONL log", async () => {
      const first = await store.createReflection({
        agentId: "agent-append",
        trigger: "manual",
        metrics: {},
        insights: ["first"],
        suggestedImprovements: ["first improvement"],
        summary: "first",
      });
      const second = await store.createReflection({
        agentId: "agent-append",
        trigger: "periodic",
        metrics: {},
        insights: ["second"],
        suggestedImprovements: ["second improvement"],
        summary: "second",
      });

      const filePath = join(rootDir, "agents", "agent-append-reflections.jsonl");
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");

      expect(lines).toHaveLength(2);
      expect((JSON.parse(lines[0]) as AgentReflection).id).toBe(first.id);
      expect((JSON.parse(lines[1]) as AgentReflection).id).toBe(second.id);
    });

    it("emits reflection:created event", async () => {
      const handler = vi.fn();
      store.on("reflection:created", handler);

      const reflection = await store.createReflection({
        agentId: "agent-events",
        trigger: "manual",
        metrics: {},
        insights: [],
        suggestedImprovements: [],
        summary: "event",
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(reflection);
    });

    it("throws when agentId is empty", async () => {
      await expect(
        store.createReflection({
          agentId: "   ",
          trigger: "manual",
          metrics: {},
          insights: [],
          suggestedImprovements: [],
          summary: "invalid",
        }),
      ).rejects.toThrow("agentId is required");
    });
  });

  describe("getReflections", () => {
    it("returns reflections in reverse chronological (newest-first) order", async () => {
      const first = await store.createReflection({
        agentId: "agent-order",
        trigger: "manual",
        metrics: {},
        insights: ["one"],
        suggestedImprovements: [],
        summary: "one",
      });
      const second = await store.createReflection({
        agentId: "agent-order",
        trigger: "manual",
        metrics: {},
        insights: ["two"],
        suggestedImprovements: [],
        summary: "two",
      });
      const third = await store.createReflection({
        agentId: "agent-order",
        trigger: "manual",
        metrics: {},
        insights: ["three"],
        suggestedImprovements: [],
        summary: "three",
      });

      const reflections = await store.getReflections("agent-order");
      expect(reflections.map((reflection) => reflection.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
    });

    it("respects the limit parameter", async () => {
      for (let i = 0; i < 4; i += 1) {
        await store.createReflection({
          agentId: "agent-limit",
          trigger: "manual",
          metrics: {},
          insights: [`insight-${i}`],
          suggestedImprovements: [],
          summary: `summary-${i}`,
        });
      }

      const reflections = await store.getReflections("agent-limit", 2);
      expect(reflections).toHaveLength(2);
    });

    it("returns an empty array when no reflection file exists", async () => {
      const reflections = await store.getReflections("agent-missing");
      expect(reflections).toEqual([]);
    });

    it("skips malformed JSONL lines gracefully", async () => {
      const agentId = "agent-malformed";
      const filePath = join(rootDir, "agents", `${agentId}-reflections.jsonl`);
      const goodOne = makeReflection(agentId, { id: "reflection-good-1", summary: "good-1" });
      const goodTwo = makeReflection(agentId, { id: "reflection-good-2", summary: "good-2" });

      writeFileSync(
        filePath,
        `${JSON.stringify(goodOne)}\n{not-json\n${JSON.stringify(goodTwo)}\n`,
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reflections = await store.getReflections(agentId, 10);

      expect(reflections).toHaveLength(2);
      expect(reflections.map((reflection) => reflection.id)).toEqual([
        "reflection-good-2",
        "reflection-good-1",
      ]);
      expect(warnSpy).toHaveBeenCalledOnce();
      warnSpy.mockRestore();
    });

    it("returns all reflections when limit exceeds total count", async () => {
      await store.createReflection({
        agentId: "agent-all",
        trigger: "manual",
        metrics: {},
        insights: ["one"],
        suggestedImprovements: [],
        summary: "one",
      });
      await store.createReflection({
        agentId: "agent-all",
        trigger: "manual",
        metrics: {},
        insights: ["two"],
        suggestedImprovements: [],
        summary: "two",
      });

      const reflections = await store.getReflections("agent-all", 100);
      expect(reflections).toHaveLength(2);
    });
  });

  describe("getLatestReflection", () => {
    it("returns the most recent reflection", async () => {
      await store.createReflection({
        agentId: "agent-latest",
        trigger: "manual",
        metrics: {},
        insights: ["older"],
        suggestedImprovements: [],
        summary: "older",
      });
      const newest = await store.createReflection({
        agentId: "agent-latest",
        trigger: "manual",
        metrics: {},
        insights: ["newer"],
        suggestedImprovements: [],
        summary: "newer",
      });

      const latest = await store.getLatestReflection("agent-latest");
      expect(latest?.id).toBe(newest.id);
    });

    it("returns null when no reflections exist", async () => {
      const latest = await store.getLatestReflection("agent-empty");
      expect(latest).toBeNull();
    });
  });

  describe("getPerformanceSummary", () => {
    it("aggregates metrics and derives strengths/weaknesses", async () => {
      await store.createReflection({
        agentId: "agent-summary",
        trigger: "post-task",
        taskId: "FN-100",
        metrics: {
          tasksCompleted: 2,
          tasksFailed: 1,
          avgDurationMs: 1000,
          commonErrors: ["timeout", "validation"],
        },
        insights: ["Great at debugging", "Clear task decomposition"],
        suggestedImprovements: ["Handle retries better", "Improve test coverage"],
        summary: "Older reflection",
      });

      await store.createReflection({
        agentId: "agent-summary",
        trigger: "post-task",
        taskId: "FN-101",
        metrics: {
          tasksCompleted: 3,
          tasksFailed: 0,
          avgDurationMs: 3000,
          commonErrors: ["timeout", "rate limit"],
        },
        insights: ["Great at debugging", "Strong communication"],
        suggestedImprovements: ["Improve test coverage", "Tune model temperature"],
        summary: "Newer reflection",
      });

      const summary = await store.getPerformanceSummary("agent-summary");

      expect(summary.agentId).toBe("agent-summary");
      expect(summary.totalTasksCompleted).toBe(5);
      expect(summary.totalTasksFailed).toBe(1);
      expect(summary.avgDurationMs).toBe(2000);
      expect(summary.successRate).toBeCloseTo(5 / 6, 10);
      expect(summary.commonErrors).toEqual(["timeout", "rate limit", "validation"]);
      expect(summary.strengths).toEqual([
        "Great at debugging",
        "Strong communication",
        "Clear task decomposition",
      ]);
      expect(summary.weaknesses).toEqual([
        "Improve test coverage",
        "Tune model temperature",
        "Handle retries better",
      ]);
      expect(summary.recentReflectionCount).toBe(2);
      expect(Number.isNaN(Date.parse(summary.computedAt))).toBe(false);
    });

    it("returns a zeroed summary when no reflections exist", async () => {
      const summary = await store.getPerformanceSummary("agent-none");

      expect(summary).toMatchObject({
        agentId: "agent-none",
        totalTasksCompleted: 0,
        totalTasksFailed: 0,
        avgDurationMs: 0,
        successRate: 0,
        commonErrors: [],
        strengths: [],
        weaknesses: [],
        recentReflectionCount: 0,
      });
      expect(Number.isNaN(Date.parse(summary.computedAt))).toBe(false);
    });

    it("excludes reflections outside the default 7-day window", async () => {
      const agentId = "agent-window-default";
      const filePath = join(rootDir, "agents", `${agentId}-reflections.jsonl`);
      const now = Date.now();

      const oldReflection = makeReflection(agentId, {
        id: "reflection-old",
        timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
        metrics: { tasksCompleted: 10 },
      });

      const recentReflection = makeReflection(agentId, {
        id: "reflection-recent",
        timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
        metrics: { tasksCompleted: 2, tasksFailed: 1 },
      });

      writeFileSync(filePath, `${JSON.stringify(oldReflection)}\n${JSON.stringify(recentReflection)}\n`, "utf-8");

      const summary = await store.getPerformanceSummary(agentId);
      expect(summary.totalTasksCompleted).toBe(2);
      expect(summary.totalTasksFailed).toBe(1);
      expect(summary.recentReflectionCount).toBe(1);
    });

    it("respects a custom windowMs option", async () => {
      const agentId = "agent-window-custom";
      const filePath = join(rootDir, "agents", `${agentId}-reflections.jsonl`);
      const now = Date.now();

      const older = makeReflection(agentId, {
        id: "reflection-older",
        timestamp: new Date(now - 10_000).toISOString(),
        metrics: { tasksCompleted: 1 },
      });
      const newest = makeReflection(agentId, {
        id: "reflection-newest",
        timestamp: new Date(now - 200).toISOString(),
        metrics: { tasksCompleted: 2 },
      });

      writeFileSync(filePath, `${JSON.stringify(older)}\n${JSON.stringify(newest)}\n`, "utf-8");

      const summary = await store.getPerformanceSummary(agentId, { windowMs: 1000 });
      expect(summary.totalTasksCompleted).toBe(2);
      expect(summary.recentReflectionCount).toBe(1);
    });

    it("emits reflection:summary-computed", async () => {
      const handler = vi.fn();
      store.on("reflection:summary-computed", handler);

      const summary = await store.getPerformanceSummary("agent-summary-event");

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(summary);
    });
  });

  describe("deleteReflections", () => {
    it("removes the agent reflection file", async () => {
      const agentId = "agent-delete";
      await store.createReflection({
        agentId,
        trigger: "manual",
        metrics: {},
        insights: [],
        suggestedImprovements: [],
        summary: "to delete",
      });

      const filePath = join(rootDir, "agents", `${agentId}-reflections.jsonl`);
      expect(existsSync(filePath)).toBe(true);

      await store.deleteReflections(agentId);
      expect(existsSync(filePath)).toBe(false);
    });

    it("no-ops when the file does not exist", async () => {
      await expect(store.deleteReflections("agent-missing-delete")).resolves.toBeUndefined();
    });
  });

  describe("concurrency", () => {
    it("allows concurrent createReflection calls for the same agent", async () => {
      const agentId = "agent-concurrent";
      const triggers: ReflectionTrigger[] = ["manual", "periodic", "post-task", "user-requested"];

      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          store.createReflection({
            agentId,
            trigger: triggers[i % triggers.length],
            metrics: { tasksCompleted: 1 },
            insights: [`insight-${i}`],
            suggestedImprovements: [`improvement-${i}`],
            summary: `summary-${i}`,
          }),
        ),
      );

      const reflections = await store.getReflections(agentId, 100);
      expect(reflections).toHaveLength(25);

      const filePath = join(rootDir, "agents", `${agentId}-reflections.jsonl`);
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(25);
    });
  });

  describe("append-only behavior", () => {
    it("preserves all reflections for the same agent in file order", async () => {
      const first = await store.createReflection({
        agentId: "agent-append-order",
        trigger: "manual",
        metrics: {},
        insights: ["first"],
        suggestedImprovements: [],
        summary: "first",
      });
      const second = await store.createReflection({
        agentId: "agent-append-order",
        trigger: "manual",
        metrics: {},
        insights: ["second"],
        suggestedImprovements: [],
        summary: "second",
      });
      const third = await store.createReflection({
        agentId: "agent-append-order",
        trigger: "manual",
        metrics: {},
        insights: ["third"],
        suggestedImprovements: [],
        summary: "third",
      });

      const filePath = join(rootDir, "agents", "agent-append-order-reflections.jsonl");
      const ids = readFileSync(filePath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as AgentReflection).id);

      expect(ids).toEqual([first.id, second.id, third.id]);
    });
  });
});
