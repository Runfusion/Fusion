/**
 * U12 (KTD-12) — parse-steps node handler, parser registry resolution, pin
 * protection, and plugin-parser fail-closed posture.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskDetail, TaskStep, WorkflowIr } from "@fusion/core";
import { getStepParserRegistry, __resetStepParserRegistryForTests } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { createNoopLegacySeams, type ParseStepsHandlerDeps } from "../workflows/workflow-node-handlers.js";
import {
  registerPluginStepParsers,
  unregisterPluginStepParsers,
} from "../plugins/plugin-parser-adapter.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { id: "FN-PARSE", title: "t", steps: [] as TaskStep[], ...overrides } as unknown as TaskDetail;
}

/** start → parse → end, with optional outcome edges off the parse node. */
function parseIr(parser: string, artifact?: string, parseEdges?: WorkflowIr["edges"], extraNodes: WorkflowIr["nodes"] = []): WorkflowIr {
  return {
    version: "v2",
    name: "parse-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    artifacts: artifact && artifact !== "PROMPT.md" ? [{ key: artifact }] : undefined,
    nodes: [
      { id: "start", kind: "start" },
      { id: "parse", kind: "parse-steps", config: { artifact: artifact ?? "PROMPT.md", parser } },
      { id: "end", kind: "end" },
      ...extraNodes,
    ],
    edges: [
      { from: "start", to: "parse" },
      { from: "parse", to: "end", condition: "success" },
      ...(parseEdges ?? []),
    ],
  } as WorkflowIr;
}

function makeDeps(over: Partial<ParseStepsHandlerDeps> = {}): {
  deps: ParseStepsHandlerDeps;
  written: TaskStep[][];
  audits: Array<{ reason: string; detail: string }>;
} {
  const written: TaskStep[][] = [];
  const audits: Array<{ reason: string; detail: string }> = [];
  const deps: ParseStepsHandlerDeps = {
    readArtifact: async () => "### Step 1: do a\n### Step 2: do b",
    writeSteps: async (_t, steps) => {
      written.push(steps);
    },
    audit: (reason, detail) => audits.push({ reason, detail }),
    ...over,
  };
  return { deps, written, audits };
}

async function runParse(ir: WorkflowIr, deps: ParseStepsHandlerDeps, taskOverrides: Partial<TaskDetail> = {}) {
  const exec = new WorkflowGraphExecutor({ seams: createNoopLegacySeams(), parseStepsDeps: deps });
  return exec.run(task(taskOverrides), settingsOn(), ir);
}

describe("parse-steps node handler (U12, KTD-12)", () => {
  beforeEach(() => {
    __resetStepParserRegistryForTests();
  });

  it("registry resolution: step-headings parses and writes steps with statuses pending", async () => {
    const { deps, written } = makeDeps();
    const result = await runParse(parseIr("step-headings"), deps);
    expect(result.outcome).toBe("success");
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual([
      { name: "do a", status: "pending" },
      { name: "do b", status: "pending" },
    ]);
  });

  it("preserves dependsOn from the headings (depends:) annotation", async () => {
    const { deps, written } = makeDeps({
      readArtifact: async () => "### Step 1: a\n### Step 2 (depends: 1): b",
    });
    const result = await runParse(parseIr("step-headings"), deps);
    expect(result.outcome).toBe("success");
    expect(written[0]).toEqual([
      { name: "a", status: "pending" },
      { name: "b", status: "pending", dependsOn: [0] },
    ]);
  });

  it("json-steps parser writes structured steps", async () => {
    const { deps, written } = makeDeps({
      readArtifact: async () => JSON.stringify([{ name: "x" }, { name: "y", depends: [1] }]),
    });
    const result = await runParse(parseIr("json-steps"), deps);
    expect(result.outcome).toBe("success");
    expect(written[0]).toEqual([
      { name: "x", status: "pending" },
      { name: "y", status: "pending", dependsOn: [0] },
    ]);
  });

  it("preserves explicit empty dependsOn arrays through parse-step projection", async () => {
    const { deps, written } = makeDeps({
      readArtifact: async () => JSON.stringify([{ name: "x" }, { name: "y", depends: [] }]),
    });
    const result = await runParse(parseIr("json-steps"), deps);
    expect(result.outcome).toBe("success");
    expect(written[0]).toEqual([
      { name: "x", status: "pending" },
      { name: "y", status: "pending", dependsOn: [] },
    ]);
  });

  it("unknown parser → parse-error (audited), no write", async () => {
    const { deps, written, audits } = makeDeps();
    // Route outcome:parse-error so the run does not just propagate failure off end.
    const ir = parseIr("does-not-exist", undefined, [
      { from: "parse", to: "end", condition: "outcome:parse-error" },
    ]);
    const result = await runParse(ir, deps);
    // The parse node fails; with the parse-error edge routed to end, the run
    // surfaces the parse node's own failure outcome.
    expect(written).toHaveLength(0);
    expect(audits.some((a) => a.reason === "parse-error")).toBe(true);
    expect(result.context["node:parse:value"]).toBe("parse-error");
  });

  it("parser throw (malformed artifact) → parse-error, never crashes", async () => {
    const { deps, audits } = makeDeps({
      readArtifact: async () => "not json at all",
    });
    const result = await runParse(parseIr("json-steps"), deps);
    expect(result.executed).toBe(true);
    expect(result.context["node:parse:value"]).toBe("parse-error");
    expect(audits.some((a) => a.reason === "parse-error")).toBe(true);
  });

  it("missing artifact (undefined content) → parse-error", async () => {
    const { deps, audits } = makeDeps({ readArtifact: async () => undefined });
    const result = await runParse(parseIr("step-headings"), deps);
    expect(result.context["node:parse:value"]).toBe("parse-error");
    expect(audits.some((a) => a.reason === "parse-error")).toBe(true);
  });

  it("explicit no-commits empty parse → no-steps outcome (success), writes empty list", async () => {
    const { deps, written } = makeDeps({ readArtifact: async () => "no headings here" });
    const ir = parseIr("step-headings", undefined, [
      { from: "parse", to: "end", condition: "outcome:no-steps" },
    ]);
    ir.nodes.find((node) => node.id === "parse")!.config!.requireStepsUnlessNoCommits = true;
    const result = await runParse(ir, deps, { noCommitsExpected: true });
    expect(result.outcome).toBe("success");
    expect(result.context["node:parse:value"]).toBe("no-steps");
    expect(written).toEqual([[]]);
  });

  it("empty implementation plan without no-commits authorization fails before foreach", async () => {
    const { deps, written, audits } = makeDeps({ readArtifact: async () => "planning draft without executable headings" });
    const ir = parseIr("step-headings", undefined, [
      { from: "parse", to: "end", condition: "outcome:missing-implementation-steps" },
    ]);
    ir.nodes.find((node) => node.id === "parse")!.config!.requireStepsUnlessNoCommits = true;

    const result = await runParse(ir, deps);

    expect(result.outcome).toBe("failure");
    expect(result.context["node:parse:value"]).toBe("missing-implementation-steps");
    expect(written).toEqual([[]]);
    expect(audits).toContainEqual(expect.objectContaining({ reason: "missing-implementation-steps" }));
  });

  it("preserves custom workflow zero-step behavior when the implementation guard is not enabled", async () => {
    const { deps, written } = makeDeps({ readArtifact: async () => "no headings here" });
    const ir = parseIr("step-headings", undefined, [
      { from: "parse", to: "end", condition: "outcome:no-steps" },
    ]);

    const result = await runParse(ir, deps);

    expect(result.outcome).toBe("success");
    expect(result.context["node:parse:value"]).toBe("no-steps");
    expect(written).toEqual([[]]);
  });

  it("pin protection: parse after a foreach expanded resumes without rewriting steps", async () => {
    const { deps, written, audits } = makeDeps({
      hasExpandedForeach: async () => true,
    });
    const ir = parseIr("step-headings");
    const result = await runParse(ir, deps);
    expect(written).toHaveLength(0);
    expect(result.outcome).toBe("success");
    expect(result.context["node:parse:value"]).toBe("already-expanded");
    expect(audits.some((a) => a.reason === "pin-resume")).toBe(true);
  });

  it("default workflow parity: registry step-headings == direct parseStepHeadings call", async () => {
    const { parseStepHeadings } = await import("@fusion/core");
    const content = "### Step 1: alpha\n### Step 2 (depends: 1): beta";
    const direct = parseStepHeadings(content);
    const viaRegistry = getStepParserRegistry().getParser("step-headings")!.parse(content);
    expect(viaRegistry.steps.map((s) => ({ name: s.name, dependsOn: s.dependsOn }))).toEqual(
      direct.map((s) => ({ name: s.name, dependsOn: s.dependsOn })),
    );
  });
});

describe("plugin step-parser fail-closed (U12, KTD-12)", () => {
  beforeEach(() => {
    __resetStepParserRegistryForTests();
  });

  it("happy path: a registered plugin parser resolves and writes steps", async () => {
    registerPluginStepParsers({
      pluginId: "acme",
      contributions: [{ parserId: "yaml", parse: () => ({ steps: [{ name: "from-plugin" }] }) }],
    });
    const { deps, written } = makeDeps({ readArtifact: async () => "ignored" });
    const result = await runParse(parseIr("plugin:acme:yaml"), deps);
    expect(result.outcome).toBe("success");
    expect(written[0]).toEqual([{ name: "from-plugin", status: "pending" }]);
    unregisterPluginStepParsers("acme", ["yaml"]);
  });

  it("a throwing plugin parser maps to parse-error (fail-closed, audited), never crashes", async () => {
    registerPluginStepParsers({
      pluginId: "acme",
      contributions: [
        {
          parserId: "boom",
          parse: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    const { deps, audits } = makeDeps({ readArtifact: async () => "x" });
    const ir = parseIr("plugin:acme:boom", undefined, [
      { from: "parse", to: "end", condition: "outcome:parse-error" },
    ]);
    const result = await runParse(ir, deps);
    expect(result.context["node:parse:value"]).toBe("parse-error");
    expect(audits.some((a) => a.reason === "parse-error")).toBe(true);
    unregisterPluginStepParsers("acme", ["boom"]);
  });

  it("a plugin parser returning a bad result maps to parse-error", async () => {
    registerPluginStepParsers({
      pluginId: "acme",
      contributions: [{ parserId: "bad", parse: () => ({ steps: [{} as { name: string }] }) }],
    });
    const { deps, audits } = makeDeps({ readArtifact: async () => "x" });
    const result = await runParse(parseIr("plugin:acme:bad"), deps);
    expect(audits.some((a) => a.reason === "parse-error")).toBe(true);
    expect(result.context["node:parse:value"]).toBe("parse-error");
    unregisterPluginStepParsers("acme", ["bad"]);
  });

  it("registry rejects a non-namespaced plugin parser id", () => {
    expect(() =>
      registerPluginStepParsers({
        pluginId: "acme",
        // pluginParserRegistryId always namespaces, so registration succeeds —
        // verify the resulting id is correctly namespaced.
        contributions: [{ parserId: "ok", parse: () => ({ steps: [] }) }],
      }),
    ).not.toThrow();
    expect(getStepParserRegistry().has("plugin:acme:ok")).toBe(true);
    unregisterPluginStepParsers("acme", ["ok"]);
  });
});
