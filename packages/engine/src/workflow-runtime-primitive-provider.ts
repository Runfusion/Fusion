import type { Settings } from "@fusion/core";

import type { WorkflowRuntimePrimitives } from "./runtime-primitives.js";

export interface WorkflowRuntimePrimitiveProvider {
  create(settings: Settings): WorkflowRuntimePrimitives;
}

export type WorkflowRuntimePrimitiveFactory = (settings: Settings) => WorkflowRuntimePrimitives;

/*
FNXC:WorkflowRuntimePrimitives 2026-07-01-00:00:
Runtime primitive creation is now exposed through a provider boundary so workflow node runners can depend on explicit primitive factories instead of reaching into TaskExecutor internals. TaskExecutor remains the substrate adapter during migration while later units move individual primitive bodies behind narrower dependencies.
*/
export class CallbackWorkflowRuntimePrimitiveProvider implements WorkflowRuntimePrimitiveProvider {
  public constructor(private readonly factory: WorkflowRuntimePrimitiveFactory) {}

  public create(settings: Settings): WorkflowRuntimePrimitives {
    return this.factory(settings);
  }
}

export function createWorkflowRuntimePrimitiveProvider(
  factory: WorkflowRuntimePrimitiveFactory,
): WorkflowRuntimePrimitiveProvider {
  return new CallbackWorkflowRuntimePrimitiveProvider(factory);
}
