import { reviewStep, type ReviewResult, type ReviewType } from "../execution/reviewer.js";

export interface WorkflowReviewStepInput {
  cwd: string;
  taskId: string;
  stepIndex: number;
  stepName: string;
  type: ReviewType;
  promptContent: string;
  baselineSha?: string;
  options?: Parameters<typeof reviewStep>[7];
}

export type WorkflowReviewStepInvoker = (input: WorkflowReviewStepInput) => Promise<ReviewResult>;

/*
FNXC:WorkflowReview 2026-07-01-00:00:
Workflow step-review nodes call reviewer behavior through this service boundary instead of invoking reviewer.ts directly from the executor seam. The executor still owns workspace fan-out and projection writes; the service owns the single-cwd review invocation contract.
*/
export class WorkflowReviewService {
  public constructor(private readonly invokeReviewStep: WorkflowReviewStepInvoker = defaultReviewStepInvoker) {}

  public async reviewStep(input: WorkflowReviewStepInput): Promise<ReviewResult> {
    return this.invokeReviewStep(input);
  }
}

const defaultReviewStepInvoker: WorkflowReviewStepInvoker = (input) =>
  reviewStep(
    input.cwd,
    input.taskId,
    input.stepIndex,
    input.stepName,
    input.type,
    input.promptContent,
    input.baselineSha,
    input.options,
  );
