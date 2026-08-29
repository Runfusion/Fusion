import type { WorkflowIrNode } from "@fusion/core";

import type {
  WorkflowNodeExecutionContext,
  WorkflowNodeHandler,
  WorkflowNodeResult,
} from "./workflow-graph-executor.js";

export type WorkflowNodeRunnerKind = WorkflowIrNode["kind"];

export type WorkflowNodeRunnerContext = WorkflowNodeExecutionContext;

export interface WorkflowNodeRunner {
  readonly kind: WorkflowNodeRunnerKind;
  run(node: WorkflowIrNode, context: WorkflowNodeRunnerContext): Promise<WorkflowNodeResult>;
}

export type WorkflowNodeRunnerMap = Partial<Record<WorkflowNodeRunnerKind, WorkflowNodeRunner>>;

export interface WorkflowNodeRunnerRegistryOptions {
  runners?: Iterable<WorkflowNodeRunner>;
  handlers?: Partial<Record<WorkflowNodeRunnerKind, WorkflowNodeHandler>>;
}

/*
FNXC:WorkflowNodeRunners 2026-07-01-00:00:
Workflow node behavior is being extracted from monolithic executor/reviewer/triage paths into typed engine-owned runners while workflow definitions remain declarative.
This registry is intentionally an adapter first: it preserves the existing WorkflowNodeHandler call contract and lets later units move node kinds one at a time without changing graph traversal semantics.
*/
export class WorkflowNodeRunnerRegistry {
  private readonly runners = new Map<WorkflowNodeRunnerKind, WorkflowNodeRunner>();

  public constructor(options: WorkflowNodeRunnerRegistryOptions = {}) {
    if (options.handlers) {
      for (const [kind, handler] of Object.entries(options.handlers) as Array<[
        WorkflowNodeRunnerKind,
        WorkflowNodeHandler | undefined,
      ]>) {
        if (handler) this.register(handlerBackedRunner(kind, handler));
      }
    }

    for (const runner of options.runners ?? []) {
      this.register(runner);
    }
  }

  public register(runner: WorkflowNodeRunner): void {
    this.runners.set(runner.kind, runner);
  }

  public get(kind: WorkflowNodeRunnerKind): WorkflowNodeRunner | undefined {
    return this.runners.get(kind);
  }

  public toHandlers(): Partial<Record<WorkflowNodeRunnerKind, WorkflowNodeHandler>> {
    const handlers: Partial<Record<WorkflowNodeRunnerKind, WorkflowNodeHandler>> = {};
    for (const [kind, runner] of this.runners) {
      handlers[kind] = (node, context) => runner.run(node, context);
    }
    return handlers;
  }
}

export function handlerBackedRunner(
  kind: WorkflowNodeRunnerKind,
  handler: WorkflowNodeHandler,
): WorkflowNodeRunner {
  return {
    kind,
    run: (node, context) => handler(node, context),
  };
}
