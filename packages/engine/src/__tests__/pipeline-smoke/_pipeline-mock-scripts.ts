import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MockScript } from "../../providers/mock-provider.js";
import { setMockScript } from "../../providers/mock-provider.js";

export type PipelineReviewMode = "approve" | "revise" | "empty-revise" | "provider-error";

export interface PipelineMockScriptState {
  planReviewIndex: number;
  codeReviewIndex: number;
  implementationCommitted: boolean;
}

export interface PipelineScriptedMergeBehavior {
  /** Legacy shared sequence; explicit plan/code sequences are preferred by new scenario drivers. */
  readonly reviewModes?: readonly PipelineReviewMode[];
  readonly planReviewModes?: readonly PipelineReviewMode[];
  readonly codeReviewModes?: readonly PipelineReviewMode[];
  /** False models S14's empty task branch; every other production drive commits through its executor session. */
  readonly commitImplementation?: boolean;
  /** Opt-in MULT-040 coverage: commit the implementation in every direct workspace child that is a Git worktree. */
  readonly commitImplementationInEveryWorkspaceRepository?: boolean;
  /** Optional tracked task-branch write used by S13 to create a real clean-room conflict. */
  readonly implementationFile?: { readonly path: string; readonly content: string };
  /** Explicit merger-owned content proves S13 took the conflict-resolution branch. */
  readonly conflictResolution?: { readonly path: string; readonly content: string };
  readonly onMergeEntered?: () => void;
  readonly waitForMerge?: Promise<void>;
  readonly resolveConflicts?: boolean;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function reviewText(mode: PipelineReviewMode, reviewKind: "plan" | "code", priorFinding = false): string {
  if (mode === "provider-error") throw new Error("mock provider unavailable");
  if (mode === "revise") {
    return JSON.stringify({
      verdict: "REVISE",
      notes: "Mock reviewer found a deterministic blocking issue.",
      findings: [reviewKind === "code"
        ? {
            id: "finding-1-1",
            title: "Correct the scripted implementation",
            body: "The disposable fixture needs the scripted remediation commit.",
            filePath: "pipeline-smoke-output.txt",
            line: 1,
            severity: "critical",
            resolution: "open",
          }
        : {
            id: "finding-1-1",
            title: "Clarify the scripted plan",
            body: "The planned fixture needs the deterministic correction pass.",
            severity: "high",
            resolution: "open",
          }],
    });
  }
  if (mode === "empty-revise") return JSON.stringify({
    verdict: "REVISE",
    notes: "Mock reviewer rejected without an actionable finding.",
    findings: [],
  });
  return JSON.stringify({
    verdict: "APPROVE",
    notes: priorFinding ? "Correction verified." : "Mock reviewer approved scripted output.",
    findings: [],
    ...(priorFinding && reviewKind === "code"
      ? { priorFindingDispositions: [{ id: "finding-1-1", resolution: "corrected" }] }
      : {}),
  });
}

/**
 * FNXC:PipelineSmoke 2026-08-23-16:40:
 * Every pipeline provider session is selected through the production mock registry. The merger
 * script distinguishes its writable squash turn from its read-only squash-review turn, because
 * both deliberately share sessionPurpose:"merger" in the real AI merge lane.
 */
export function installPipelineMockScripts(input: {
  readonly taskId: string;
  /*
  FNXC:PipelineSmoke 2026-08-24-15:40:
  Resolved when the merger RUNS, not when the script is installed. A workspace task has no branch at
  all until acquisition creates its per-repository worktree, and the scripts are installed before
  that: capturing the value handed the merger an empty ref and the land failed with
  `git merge --squash` on nothing. A getter cannot go stale.
  */
  readonly branch: () => Promise<string>;
  readonly behavior?: PipelineScriptedMergeBehavior;
  readonly state?: PipelineMockScriptState;
  readonly observeMockRuntime: () => void;
  /** Current step statuses, read live so appended remediation work is completed too. */
  readonly readTaskSteps: () => Promise<string[]>;
}): void {
  const behavior = input.behavior ?? {};
  const state = input.state ?? { planReviewIndex: 0, codeReviewIndex: 0, implementationCommitted: false };

  const merger: MockScript = {
    run: async (context) => {
      input.observeMockRuntime();
      if (context.prompt.startsWith("Review the squash merge for task")) {
        context.options.onText?.("REVIEW_VERDICT: approve");
        return;
      }
      behavior.onMergeEntered?.();
      await behavior.waitForMerge;
      try {
        const mergeBranch = await input.branch();
        if (!mergeBranch) throw new Error("pipeline smoke merger has no branch to squash");
        git(context.options.cwd, ["merge", "--squash", mergeBranch]);
      } catch (error) {
        if (!behavior.resolveConflicts) throw error;
        /*
        FNXC:PipelineSmoke 2026-08-23-21:45:
        S13 must prove the real clean-room conflict branch, not merely ask the merger to resolve
        unrelated files. Write a deterministic merger-owned resolution after Git reports the
        overlap, so the landed integration tree is durable evidence of that branch.
        */
        git(context.options.cwd, ["checkout", "--theirs", "."]);
        if (behavior.conflictResolution) {
          writeFileSync(
            join(context.options.cwd, behavior.conflictResolution.path),
            behavior.conflictResolution.content,
            "utf8",
          );
        }
        git(context.options.cwd, ["add", "-A"]);
      }
      if (git(context.options.cwd, ["diff", "--cached", "--name-only"])) {
        git(context.options.cwd, ["commit", "-m", `feat(${input.taskId}): scripted local merge`]);
      }
    },
  };

  const emitReview = async (
    context: Parameters<MockScript["run"]>[0],
    forcedKind?: "plan" | "code",
  ): Promise<void> => {
    input.observeMockRuntime();
    const systemPrompt = context.options.systemPrompt ?? "";
    const reviewKind = forcedKind ?? (
      /workflow step agent executing:\s*(?:Documentation & Delivery|Verification)\b/i.test(systemPrompt)
        ? "non-review"
        : /^Execute the workflow step "Plan Review"/i.test(context.prompt)
      || /workflow step agent executing:\s*Plan Review\b/i.test(systemPrompt)
        ? "plan"
        : "code"
    );
    /*
    FNXC:PipelineSmoke 2026-08-24-17:30:
    Only a REAL review gate may consume a scenario's scripted verdicts. This classifier answered
    "code" for anything that was not Plan Review, so on a review-column workflow the
    Documentation & Delivery gate ate the verdict aimed at Code Review: S07 scripts
    `codeReviewModes: ["empty-revise"]` to exercise an unactionable Code Review rejection, and the
    card died with `documentation-delivery: failed: REVISE` before Code Review ever ran.
    Detected on the workflow-step system prompt, which names the executing step, and by EXCLUSION
    rather than an allow-list: the real reviewer prompt does not carry the literal "Code Review", so
    allow-listing silently approves every genuine review instead.
    */
    if (reviewKind === "non-review") {
      context.options.onText?.(JSON.stringify({ verdict: "APPROVE", notes: "Mock gate completed a non-review workflow step.", findings: [] }));
      return;
    }
    const modes = reviewKind === "plan"
      ? (behavior.planReviewModes ?? behavior.reviewModes ?? ["approve"])
      : (behavior.codeReviewModes ?? behavior.reviewModes ?? ["approve"]);
    const index = reviewKind === "plan" ? state.planReviewIndex : state.codeReviewIndex;
    const mode = modes[Math.min(index, modes.length - 1)] ?? "approve";
    const priorFinding = index > 0 && modes.slice(0, index).includes("revise");
    if (reviewKind === "plan") state.planReviewIndex += 1;
    else state.codeReviewIndex += 1;
    context.options.onText?.(reviewText(mode, reviewKind, priorFinding));
  };

  const reviewer: MockScript = { run: emitReview };

  const executor: MockScript = {
    run: async (context) => {
      const systemPrompt = context.options.systemPrompt ?? "";
      const reviewPrompt = `${context.prompt}\n${systemPrompt}`;
      const reviewTurn = /^Execute the workflow step "(?:Plan Review|Code Review)"/i.test(context.prompt)
        || /workflow step agent executing:\s*(?:Plan Review|Code Review)\b/i.test(systemPrompt);
      if (reviewTurn) {
        await emitReview({ ...context, prompt: reviewPrompt });
        return;
      }
      const hasTaskUpdateTool = context.tools.some((tool) => tool.name === "fn_task_update");
      /*
      FNXC:PipelineSmoke 2026-08-24-17:30:
      ...but a NON-REVIEW gate also arrives readonly. Documentation & Delivery has no task-update
      tool either, so this heuristic handed it the verdict scripted for Code Review: S07 scripts
      `codeReviewModes: ["empty-revise"]` to exercise an unactionable Code Review rejection, and on a
      review-column workflow the card instead died with `documentation-delivery: failed: REVISE`
      before Code Review ever ran. Identify the executing step from the workflow-step system prompt
      and let only a real review consume the scripted verdicts.
      */
      /*
      FNXC:PipelineSmoke 2026-08-24-18:10:
      Route a GATE turn by the step it names, never by its tool surface. Code Review is a writable
      inline-fix review, so on a review-column workflow it arrives WITH the task-update tool and
      fell through to the implementation branch below, which ends by emitting a blanket APPROVE.
      The scenario's scripted verdict was silently ignored: S07 asks for `empty-revise` and the
      persisted result was `code-review:passed:APPROVE:code` — which then sealed the tree and
      blocked the replay of Documentation & Delivery, two failures downstream of one mislabel.
      `Execute the workflow step "<name>"` is the reliable marker: it is present on every gate turn
      and absent from the implementation session, whose system prompt is the generic executor
      preamble.
      */
      const gateStep = /^Execute the workflow step "([^"]+)"/i.exec(context.prompt)?.[1];
      if (gateStep) {
        if (/^Code Review$/i.test(gateStep)) { await emitReview(context, "code"); return; }
        if (/^Plan Review$/i.test(gateStep)) { await emitReview(context, "plan"); return; }
        /*
        FNXC:PipelineSmoke 2026-08-24-20:10:
        A non-review gate that can WRITE must still finish the work it was handed. Code Review
        Remediation is exactly that: a coding session whose job is to complete the trailing steps the
        REVISE reopened. Returning a bare approval here skipped that, so the reopened step stayed
        `pending`, the merge boundary's foreach coverage never completed, and S05 terminalized with
        `merge-boundary-unproven`.
        */
        if (hasTaskUpdateTool) {
          const pending = await input.readTaskSteps();
          for (let index = 0; index < pending.length; index += 1) {
            if (pending[index] !== "pending" && pending[index] !== "in-progress") continue;
            await context.invokeTool("fn_task_update", { step: index, status: "done" });
          }
        }
        context.options.onText?.(JSON.stringify({ verdict: "APPROVE", notes: `Mock gate completed ${gateStep}.`, findings: [] }));
        return;
      }
      if (!hasTaskUpdateTool && behavior.codeReviewModes) {
        /*
        FNXC:PipelineSmoke 2026-08-23-20:23:
        Final Code Review can arrive on the executor runtime with a generic dispatch prompt. Its
        readonly tool surface distinguishes it from graph-owned implementation, preserving the
        scripted review verdict rather than treating the gate as an ordinary execution turn.
        */
        await emitReview(context, "code");
        return;
      }
      input.observeMockRuntime();
      /*
      FNXC:PipelineSmoke 2026-08-23-19:31:
      The executor mock creates its change from inside the real production session. This keeps
      acquisition, graph projection, review fingerprints, and the merger's local Git input on
      the same path as an operator task instead of pre-seeding a branch before execution starts.
      */
      /*
      FNXC:PipelineSmoke 2026-08-24-11:05:
      A WORKSPACE session runs from the task DIRECTORY, whose per-repository children hold the Git
      metadata; the container itself has no `.git`. The original `existsSync(cwd/.git)` guard
      therefore skipped the whole block on a workspace task, the executor produced no commit, and
      Code Review reported "No changes — not reviewed" on a scoped repository that was genuinely
      untouched. Resolve the repository the session can actually commit in, exactly as a real
      executor does through task-start workspace provisioning.
      */
      const implementationRepoDir = existsSync(join(context.options.cwd, ".git"))
        ? context.options.cwd
        : readdirSync(context.options.cwd, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(context.options.cwd, entry.name))
          .find((candidate) => existsSync(join(candidate, ".git")));
      /*
      FNXC:PipelineSmoke 2026-08-29-12:48:
      FN-259 must reproduce MULT-040 with two modified workspace repositories. Keep the default
      first-child selection byte-identical for existing single-repository scenarios; the opt-in
      flag writes one real task-branch commit in every direct Git child so Code Review must publish
      evidence for both repositories before the workspace merge can complete.
      */
      const implementationRepoDirs = behavior.commitImplementationInEveryWorkspaceRepository
        ? (existsSync(join(context.options.cwd, ".git"))
          ? [context.options.cwd]
          : readdirSync(context.options.cwd, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(context.options.cwd, entry.name))
            .filter((candidate) => existsSync(join(candidate, ".git"))))
        : implementationRepoDir ? [implementationRepoDir] : [];
      if (!state.implementationCommitted && behavior.commitImplementation !== false && implementationRepoDirs.length > 0) {
        /*
        FNXC:PipelineSmoke 2026-08-23-21:45:
        Most rows use an isolated output file, while S13 deliberately writes README.md so the
        integration checkout can make the same tracked change and force the production merger's
        conflict path. The executor still performs this write inside its real task worktree.
        */
        const implementation = behavior.implementationFile ?? {
          path: "pipeline-smoke-output.txt",
          content: `pipeline smoke implementation for ${input.taskId}\n`,
        };
        for (const implementationRepoDir of implementationRepoDirs) {
          writeFileSync(join(implementationRepoDir, implementation.path), implementation.content, "utf8");
          git(implementationRepoDir, ["add", "--", implementation.path]);
          if (git(implementationRepoDir, ["diff", "--cached", "--name-only"])) {
            git(implementationRepoDir, ["commit", "-m", `feat(${input.taskId}): mock executor implementation`]);
          }
        }
        state.implementationCommitted = true;
      }
      if (hasTaskUpdateTool) {
        /*
        FNXC:PipelineSmoke 2026-08-24-19:00:
        Complete EVERY pending step, not only step 0. A review gate that appends named remediation
        work (`review-remediation-steps`) adds steps beyond the first, and a workflow whose parse
        node disables trailing-step reopening depends on exactly that mechanism to give the bounced
        card something to execute. Marking only step 0 left those remediation steps pending forever,
        so the card could never satisfy the completed-implementation projection and S05
        ("REVISE twice, then approve") stalled with
        "did not persist completed implementation-step projection". A real executor finishes the
        steps it was handed; the mock must too.
        */
        const live = await input.readTaskSteps();
        for (let index = 0; index < Math.max(live.length, 1); index += 1) {
          if (live[index] && live[index] !== "pending" && live[index] !== "in-progress") continue;
          await context.invokeTool("fn_task_update", { step: index, status: "done" });
        }
      }
      /*
      FNXC:PipelineSmoke 2026-08-23-20:23:
      Generic graph execution turns still need a canonical approval payload: implementation ignores
      it, while any review gateway receiving that runtime shape parses it through production text
      subscription rather than a test-only callback.
      */
      context.options.onText?.(JSON.stringify({ verdict: "APPROVE", notes: "Mock executor completed graph-owned task progress.", findings: [] }));
    },
  };

  const triage: MockScript = {
    run: async (context) => {
      const systemPrompt = context.options.systemPrompt ?? "";
      const reviewPrompt = `${context.prompt}\n${systemPrompt}`;
      const reviewTurn = /^Execute the workflow step "(?:Plan Review|Code Review)"/i.test(context.prompt)
        || /workflow step agent executing:\s*(?:Plan Review|Code Review)\b/i.test(systemPrompt);
      if (reviewTurn) {
        await emitReview({ ...context, prompt: reviewPrompt });
        return;
      }
      input.observeMockRuntime();
      context.options.onText?.("Mock triage completed the production planning step.");
    },
  };

  /*
  FNXC:PipelineSmoke 2026-08-23-20:23:
  Graph prompt gates may resolve through validation or a deferred heartbeat lane rather than the
  reviewer runtime. Keep every lane on the same structured verdict surface so Plan/Code Review
  remain real mock-backed sessions.
  */
  const validation: MockScript = { run: emitReview };
  const heartbeat: MockScript = { run: emitReview };

  for (const [sessionPurpose, script] of [
    ["merger", merger],
    ["reviewer", reviewer],
    ["executor", executor],
    ["triage", triage],
    ["validation", validation],
    ["heartbeat", heartbeat],
  ] as const) {
    setMockScript({ sessionPurpose, taskId: input.taskId }, script);
    /*
    FNXC:PipelineSmoke 2026-08-23-20:23:
    Some graph-owned review sessions omit taskId from runtime options. The documented
    sessionPurpose:* fallback must retain this deterministic script instead of silently using a
    default that turns a real gate into malformed output.
    */
    setMockScript({ sessionPurpose }, script);
  }
}
