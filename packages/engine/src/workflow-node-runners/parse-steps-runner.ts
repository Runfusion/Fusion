import { getStepParser } from "@fusion/core";
import type { TaskDetail, TaskStep, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "../workflow-graph-executor.js";
import type { WorkflowNodeRunner, WorkflowNodeRunnerContext } from "../workflow-node-runner.js";

/** The implicit default step-source artifact when a workflow declares no artifacts. */
export const PARSE_STEPS_DEFAULT_ARTIFACT = "PROMPT.md";

export interface ParseStepsHandlerDeps {
  readArtifact: (task: TaskDetail, key: string) => Promise<string | undefined>;
  writeSteps: (task: TaskDetail, steps: TaskStep[]) => Promise<void>;
  hasExpandedForeach?: (task: TaskDetail) => Promise<boolean> | boolean;
  audit?: (reason: string, detail: string) => void;
}

/*
FNXC:WorkflowNodeRunners 2026-07-01-00:00:
Parse-steps is a runner because it is the graph-owned authority for translating task artifacts into canonical task steps. It must preserve pin protection and fail closed on parser/artifact/projection errors so foreach instances cannot desynchronize from the task projection.
*/
export class ParseStepsNodeRunner implements WorkflowNodeRunner {
  public readonly kind = "parse-steps" as const;

  public constructor(private readonly deps: ParseStepsHandlerDeps) {}

  public async run(node: WorkflowIrNode, ctx: WorkflowNodeRunnerContext): Promise<WorkflowNodeResult> {
    const cfg = (node.config ?? {}) as { artifact?: unknown; parser?: unknown };
    const parserId = typeof cfg.parser === "string" ? cfg.parser : "";
    const artifactKey =
      typeof cfg.artifact === "string" && cfg.artifact.trim() !== ""
        ? cfg.artifact
        : PARSE_STEPS_DEFAULT_ARTIFACT;

    try {
      if (this.deps.hasExpandedForeach && (await this.deps.hasExpandedForeach(ctx.task))) {
        this.audit(
          "pin-resume",
          `parse-steps node '${node.id}' reached after a foreach already expanded for task ${ctx.task.id}; preserving pinned steps`,
        );
        return { outcome: "success", value: "already-expanded" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit("pin-mismatch", `parse-steps node '${node.id}' pin probe failed: ${message}`);
      return { outcome: "failure", value: "pin-mismatch" };
    }

    const parser = getStepParser(parserId);
    if (!parser) {
      this.audit(
        "parse-error",
        `parse-steps node '${node.id}' references unknown parser '${parserId}'`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    let content: string | undefined;
    try {
      content = await this.deps.readArtifact(ctx.task, artifactKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit(
        "parse-error",
        `parse-steps node '${node.id}' artifact '${artifactKey}' read failed: ${message}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }
    if (content === undefined) {
      this.audit(
        "parse-error",
        `parse-steps node '${node.id}' artifact '${artifactKey}' not found for task ${ctx.task.id}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    let parsedSteps;
    try {
      parsedSteps = parser.parse(content).steps;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit(
        "parse-error",
        `parse-steps node '${node.id}' parser '${parserId}' threw: ${message}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    if (parsedSteps.length === 0) {
      try {
        await this.deps.writeSteps(ctx.task, []);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.audit(
          "parse-error",
          `parse-steps node '${node.id}' failed to write empty step list: ${message}`,
        );
        return { outcome: "failure", value: "parse-error" };
      }
      return { outcome: "success", value: "no-steps" };
    }

    const steps: TaskStep[] = parsedSteps.map((s) => {
      const step: TaskStep = { name: s.name, status: "pending" };
      if (Array.isArray(s.dependsOn)) step.dependsOn = s.dependsOn;
      return step;
    });
    try {
      await this.deps.writeSteps(ctx.task, steps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit(
        "parse-error",
        `parse-steps node '${node.id}' failed to write ${steps.length} steps: ${message}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    return { outcome: "success" };
  }

  private audit(reason: string, detail: string): void {
    try {
      this.deps.audit?.(reason, detail);
    } catch {
      // Audit must never affect the run.
    }
  }
}

export function createParseStepsHandler(deps: ParseStepsHandlerDeps): WorkflowNodeHandler {
  const runner = new ParseStepsNodeRunner(deps);
  return (node, context) => runner.run(node, context);
}
