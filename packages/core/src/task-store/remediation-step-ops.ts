import type { TaskStore } from "../store.js";
import type { Task, TaskStep } from "../types.js";
import { hasOpenEquivalentRemediationStep, remediationWaveCount } from "../tasks/remediation-steps.js";
import { planRemediationPlacement } from "../tasks/remediation-step-placement.js";
import { buildStepLedgerReopenLog } from "./step-ledger-seal.js";

export interface AppendRemediationStepsOptions {
  wave?: number;
}

export interface AppendRemediationStepsResult {
  task: Task;
  appended: TaskStep[];
  appendedCount: number;
  wave: number;
  insertionIndex?: number;
  verificationStepIndex?: number;
}

/**
 * FNXC:ReviewGatedCoding 2026-08-23-04:52:
 * Remediation can arrive while an execution session owns the same task. Append under the task's
 * atomic mutation so existing implementation steps are never reordered, rewritten, or lost.
 */
export async function appendRemediationStepsImpl(
  store: Pick<TaskStore, "updateTaskAtomic">,
  taskId: string,
  candidates: readonly TaskStep[],
  options: AppendRemediationStepsOptions = {},
): Promise<AppendRemediationStepsResult> {
  let appended: TaskStep[] = [];
  let wave = 0;
  let insertionIndex: number | undefined;
  let verificationStepIndex: number | undefined;
  const task = await store.updateTaskAtomic(taskId, (current) => {
    const existing = current.steps ?? [];
    wave = options.wave ?? remediationWaveCount(existing) + 1;
    appended = candidates
      .filter((candidate) => candidate.remediation !== undefined)
      .filter((candidate) => !hasOpenEquivalentRemediationStep([...existing, ...appended], candidate))
      .map((candidate) => ({
        ...candidate,
        status: "pending",
        remediation: { ...candidate.remediation!, wave: candidate.remediation?.wave ?? wave },
        ...(candidate.dependsOn ? { dependsOn: [...candidate.dependsOn] } : {}),
      }));
    if (appended.length === 0) return null;
    const placement = planRemediationPlacement(existing, appended);
    insertionIndex = placement.insertionIndex;
    verificationStepIndex = placement.verificationStepIndex;
    /*
    FNXC:StepLedgerIntegrity 2026-08-31-09:44:
    Appending remediation after a clean completion IS a reopening of implementation, and it must say
    so or the work it just created cannot run.

    `evaluateStepLedgerSeal` refuses any step transition once the log tail carries a completion
    marker such as "Task marked done by agent", until a re-entry marker supersedes it. Re-entry
    comes from a fresh executor session, a resume-after-unpause, or this shared reopen stamp -- and
    `updateStep` also stamps pending resets, operator edits, and admitted starts of pending work.
    Remediation arrives through THIS append instead, so it wrote no stamp: the seal survived, and the
    graph's very next act -- taking the new Fix step to `in-progress` -- was refused as a
    post-completion projection. The card was moved back for repair and then could not start it.

    Measured on FN-270: "Review gate Code Review requested named remediation - moved back to
    in-progress", immediately followed by "Ignored post-completion in-progress for step 6 (Fix: ...)"
    and a graph failure at `steps#6:step-execute`.

    Stamped inside the same atomic mutation as the append, so no window exists in which the steps
    exist while the ledger still claims completion.
    */
    const log = buildStepLedgerReopenLog(
      current.log,
      `${appended.length} remediation step(s) appended after completion (wave ${wave})`,
    );
    return {
      steps: placement.steps,
      currentStep: placement.insertionIndex,
      ...(log ? { log } : {}),
    };
  });
  return {
    task,
    appended,
    appendedCount: appended.length,
    wave,
    ...(insertionIndex === undefined ? {} : { insertionIndex }),
    ...(verificationStepIndex === undefined ? {} : { verificationStepIndex }),
  };
}
