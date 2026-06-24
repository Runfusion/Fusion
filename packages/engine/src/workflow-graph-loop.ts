import type { WorkflowIrEdge, WorkflowIrNode, WorkflowLoopConfig, WorkflowOptionalGroupConfig } from "@fusion/core";
import { WorkflowIrError } from "@fusion/core";

import type { WorkflowNodeOutcome, WorkflowNodeResult } from "./workflow-graph-executor.js";

const DEFAULT_MAX_ITERATIONS = 3;
const MAX_ITERATIONS_CAP = 50;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;

interface LoopConfig {
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] };
  exitWhen: WorkflowLoopConfig["exitWhen"];
  exitRegex?: RegExp;
  maxIterations: number;
  timeoutMs: number;
}

export interface LoopEnvironment {
  context: Record<string, unknown>;
  runTemplateNode: (
    node: WorkflowIrNode,
    signal?: AbortSignal,
    contextOverride?: Record<string, unknown>,
  ) => Promise<WorkflowNodeResult>;
  shouldTraverseEdge: (edge: WorkflowIrEdge, source: WorkflowNodeResult) => boolean;
  signal?: AbortSignal;
  now?: () => number;
}

export interface LoopRunResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
  visitedNodeIds: string[];
}

function resolveLoopConfig(node: WorkflowIrNode): LoopConfig {
  const cfg = (node.config ?? {}) as Partial<WorkflowLoopConfig>;
  if (!cfg.template || !Array.isArray(cfg.template.nodes) || !Array.isArray(cfg.template.edges)) {
    throw new WorkflowIrError(`loop node '${node.id}' has no template subgraph`);
  }
  if (!cfg.exitWhen) {
    throw new WorkflowIrError(`loop node '${node.id}' has no exitWhen condition`);
  }
  const maxIterations =
    typeof cfg.maxIterations === "number" && Number.isFinite(cfg.maxIterations)
      ? Math.max(1, Math.min(MAX_ITERATIONS_CAP, Math.floor(cfg.maxIterations)))
      : DEFAULT_MAX_ITERATIONS;
  const timeoutMs =
    typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs)
      ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(cfg.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
  const exitRegex =
    cfg.exitWhen.type === "output-matches" ? new RegExp(cfg.exitWhen.pattern, cfg.exitWhen.flags) : undefined;
  return {
    template: cfg.template,
    exitWhen: cfg.exitWhen,
    exitRegex,
    maxIterations,
    timeoutMs,
  };
}

function buildOutgoing(edges: WorkflowIrEdge[]): Map<string, WorkflowIrEdge[]> {
  const outgoing = new Map<string, WorkflowIrEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  return outgoing;
}

function findTemplateEntry(nodes: WorkflowIrNode[], edges: WorkflowIrEdge[], loopId: string): WorkflowIrNode {
  const incoming = new Map<string, number>();
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const entries = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  if (entries.length !== 1) {
    throw new WorkflowIrError(`loop node '${loopId}' template must have exactly one entry node`);
  }
  return entries[0];
}

function exitNodeId(nodes: WorkflowIrNode[], edges: WorkflowIrEdge[], loopId: string): string {
  const outgoing = new Map<string, number>();
  for (const edge of edges) outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  const exits = nodes.filter((n) => (outgoing.get(n.id) ?? 0) === 0);
  if (exits.length !== 1) {
    throw new WorkflowIrError(`loop node '${loopId}' template must have exactly one exit node`);
  }
  return exits[0].id;
}

function matchesExit(config: LoopConfig, value: unknown): boolean {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const condition = config.exitWhen;
  if (condition.type === "output-contains") {
    return text.includes(condition.value);
  }
  return (config.exitRegex ?? new RegExp(condition.pattern, condition.flags)).test(text);
}

function publishIterationContext(
  target: Record<string, unknown>,
  iterationContext: Record<string, unknown>,
): void {
  const { ["loop:active"]: _active, ...publicContext } = iterationContext;
  Object.assign(target, publicContext);
}

export async function runLoop(
  loopNode: WorkflowIrNode,
  env: LoopEnvironment,
): Promise<LoopRunResult> {
  const config = resolveLoopConfig(loopNode);
  const templateById = new Map(config.template.nodes.map((n) => [n.id, n]));
  const outgoing = buildOutgoing(config.template.edges);
  const entry = findTemplateEntry(config.template.nodes, config.template.edges, loopNode.id);
  const defaultExitNodeId = exitNodeId(config.template.nodes, config.template.edges, loopNode.id);
  const sourceNodeId = config.exitWhen.nodeId ?? defaultExitNodeId;
  const now = env.now ?? (() => Date.now());
  const deadline = now() + config.timeoutMs;
  const visitedNodeIds: string[] = [];
  const iterationSummaries: Array<{ iteration: number; outcome: string; value?: string }> = [];

  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    if (env.signal?.aborted) {
      return { outcome: "failure", value: "aborted", visitedNodeIds };
    }
    if (now() >= deadline) {
      env.context[`node:${loopNode.id}:loop`] = {
        iterations: iteration - 1,
        exitReason: "timeout",
        history: iterationSummaries,
      };
      return { outcome: "failure", value: "loop-timeout", visitedNodeIds };
    }

    const iterationContext: Record<string, unknown> = {
      ...env.context,
      "loop:active": {
        loopNodeId: loopNode.id,
        iteration,
      },
    };
    let current: WorkflowIrNode | undefined = entry;
    let lastResult: WorkflowNodeResult = { outcome: "success" };

    while (current) {
      if (env.signal?.aborted) {
        return { outcome: "failure", value: "aborted", visitedNodeIds };
      }
      if (now() >= deadline) {
        env.context[`node:${loopNode.id}:loop`] = {
          iterations: iteration - 1,
          exitReason: "timeout",
          history: iterationSummaries,
        };
        return { outcome: "failure", value: "loop-timeout", visitedNodeIds };
      }

      const materializedId = `${loopNode.id}#${iteration}:${current.id}`;
      visitedNodeIds.push(materializedId);
      lastResult = await env.runTemplateNode(current, env.signal, iterationContext);
      if (lastResult.contextPatch) Object.assign(iterationContext, lastResult.contextPatch);
      iterationContext[`node:${current.id}:outcome`] = lastResult.outcome;
      if (lastResult.value !== undefined) iterationContext[`node:${current.id}:value`] = lastResult.value;
      if (lastResult.outcome === "failure") {
        publishIterationContext(env.context, iterationContext);
        env.context[`node:${loopNode.id}:loop`] = {
          iterations: iteration,
          exitReason: "node-failure",
          history: iterationSummaries,
        };
        return { outcome: "failure", value: lastResult.value, visitedNodeIds };
      }

      const edges: WorkflowIrEdge[] = outgoing.get(current.id) ?? [];
      const matching: WorkflowIrEdge[] = edges.filter((edge: WorkflowIrEdge) =>
        env.shouldTraverseEdge(edge, lastResult),
      );
      current = matching.length > 0 ? templateById.get(matching[0].to) : undefined;
    }

    const sourceValue = iterationContext[`node:${sourceNodeId}:value`];
    const finalValue = sourceValue ?? lastResult.value;
    iterationSummaries.push({
      iteration,
      outcome: lastResult.outcome,
      ...(finalValue !== undefined ? { value: String(finalValue) } : {}),
    });
    publishIterationContext(env.context, iterationContext);
    if (matchesExit(config, finalValue)) {
      env.context[`node:${loopNode.id}:loop`] = {
        iterations: iteration,
        exitReason: "matched",
        finalValue,
        history: iterationSummaries,
      };
      return { outcome: "success", visitedNodeIds };
    }
  }

  env.context[`node:${loopNode.id}:loop`] = {
    iterations: config.maxIterations,
    exitReason: "iteration-exhausted",
    history: iterationSummaries,
  };
  return { outcome: "failure", value: "loop-iteration-exhausted", visitedNodeIds };
}

/*
FNXC:WorkflowOptionalGroup 2026-06-21-14:05:
An enabled `optional-group` runs its `template` subgraph EXACTLY ONCE (single pass — no iteration, no rework budget; rework edges are validation-forbidden inside the template). This reuses the loop's template-walk primitives (`buildOutgoing`, `findTemplateEntry`, `shouldTraverseEdge`) but caps the walk at one pass. The disabled/bypass decision lives in the executor branch (read from per-task `enabledWorkflowSteps`); this helper only runs the body when enabled.
A template-node failure surfaces as the group's outcome so the group's `failure`/`outcome:` edges route, mirroring `runLoop`'s node-failure short-circuit.
*/
export interface OptionalGroupEnvironment {
  context: Record<string, unknown>;
  runTemplateNode: (
    node: WorkflowIrNode,
    signal?: AbortSignal,
    contextOverride?: Record<string, unknown>,
  ) => Promise<WorkflowNodeResult>;
  shouldTraverseEdge: (edge: WorkflowIrEdge, source: WorkflowNodeResult) => boolean;
  signal?: AbortSignal;
}

export interface OptionalGroupRunResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
  visitedNodeIds: string[];
}

function resolveOptionalGroupTemplate(
  node: WorkflowIrNode,
): { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] } {
  const cfg = (node.config ?? {}) as Partial<WorkflowOptionalGroupConfig>;
  if (!cfg.template || !Array.isArray(cfg.template.nodes) || !Array.isArray(cfg.template.edges)) {
    throw new WorkflowIrError(`optional-group node '${node.id}' has no template subgraph`);
  }
  return cfg.template;
}

/**
 * Walk an enabled optional-group's template subgraph once. Mirrors a single
 * loop iteration: entry → follow matching edges → stop at the template exit (no
 * outgoing matching edge). Materialized visited ids use a `<groupId>::<templateNodeId>`
 * scheme so they are distinguishable from top-level ids and parseable back to the
 * template node. The group's own outcome is the last template node's outcome.
 */
export async function runOptionalGroup(
  groupNode: WorkflowIrNode,
  env: OptionalGroupEnvironment,
): Promise<OptionalGroupRunResult> {
  const template = resolveOptionalGroupTemplate(groupNode);
  const templateById = new Map(template.nodes.map((n) => [n.id, n]));
  const outgoing = buildOutgoing(template.edges);
  const entry = findTemplateEntry(template.nodes, template.edges, groupNode.id);
  const visitedNodeIds: string[] = [];

  const groupContext: Record<string, unknown> = { ...env.context };
  let current: WorkflowIrNode | undefined = entry;
  let lastResult: WorkflowNodeResult = { outcome: "success" };

  while (current) {
    if (env.signal?.aborted) {
      return { outcome: "failure", value: "aborted", visitedNodeIds };
    }

    const materializedId = `${groupNode.id}::${current.id}`;
    visitedNodeIds.push(materializedId);
    lastResult = await env.runTemplateNode(current, env.signal, groupContext);
    if (lastResult.contextPatch) Object.assign(groupContext, lastResult.contextPatch);
    groupContext[`node:${current.id}:outcome`] = lastResult.outcome;
    if (lastResult.value !== undefined) groupContext[`node:${current.id}:value`] = lastResult.value;

    if (lastResult.outcome === "failure") {
      // Publish accumulated template context, then surface the failure as the
      // group's outcome so its failure/outcome: edges route.
      Object.assign(env.context, groupContext);
      return { outcome: "failure", value: lastResult.value, visitedNodeIds };
    }

    const edges: WorkflowIrEdge[] = outgoing.get(current.id) ?? [];
    const matching: WorkflowIrEdge[] = edges.filter((edge: WorkflowIrEdge) =>
      env.shouldTraverseEdge(edge, lastResult),
    );
    current = matching.length > 0 ? templateById.get(matching[0].to) : undefined;
  }

  // Single pass complete: publish the template's context onto the shared context.
  Object.assign(env.context, groupContext);
  return { outcome: lastResult.outcome, value: lastResult.value, visitedNodeIds };
}
