import { WorkflowIrError, getStepParser, instanceNodeId } from "@fusion/core";
import type { TaskDetail, TaskStep, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "./workflow-graph-executor.js";

export type WorkflowSeamName = "planning" | "execute" | "review" | "merge" | "schedule" | "step-execute";

export interface WorkflowLegacySeams {
  /** Planning/spec stage. Built-in triage runs upstream of the interpreter
   *  today, so the default engine seam is a no-op for already-specified tasks;
   *  custom planning behavior is expressed as a custom prompt node. */
  planning: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  execute: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  review: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  merge: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  schedule: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /**
   * Step-inversion (KTD-2/KTD-4, U3): run exactly the foreach-active step inside
   * the task's session/worktree. Only invoked for `step-execute` prompt nodes
   * inside a foreach template, where `context["foreach:active"]` carries the
   * active instance's `stepIndex`. Optional — a workflow that never uses a
   * foreach/step-execute node needs no implementation (the noop seams omit it,
   * and a step-execute node reached without this wired fails cleanly rather than
   * silently no-opping). The engine wires this to `runTaskStep` (executor.ts
   * createGraphSeams); it returns the per-step `baselineSha`/`checkpointId` in
   * its `contextPatch` so a later RETHINK (U5) can reset the step.
   */
  stepExecute?: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /**
   * Step-inversion (KTD-4, U5): review the foreach-active step. Only invoked for
   * `step-review` nodes inside a foreach template, where `context["foreach:active"]`
   * carries the active instance. The seam calls `reviewStep` (reviewer.ts) under
   * `semaphore.runNested` against the instance's step + the task's PROMPT content
   * (the same way `fn_review_step` does), and — on an authoritative (non-advisory)
   * APPROVE — marks the step `done` through the projection (`updateStep(source:"graph")`,
   * KTD-7). It persists the verdict back into the active context so the foreach
   * sub-walk can write it into the instance row (KTD-6). It returns the raw verdict;
   * the {@link createStepReviewHandler} handler maps it to the outcome value the
   * `outcome:approve|revise|rethink|unavailable` edges route on. Optional — a
   * workflow without a step-review node needs no implementation.
   *
   * @param advisory when true (the node is inside a `split` branch — single-writer
   *   rule, KTD-4) the seam must NOT write the projection and only logs an audit
   *   note; the verdict is advisory and never routes the authoritative instance.
   */
  stepReview?: (
    task: TaskDetail,
    context: Record<string, unknown>,
    config: StepReviewConfig,
  ) => Promise<StepReviewSeamResult>;
}

/** Config a `step-review` node carries (KTD-4). */
export interface StepReviewConfig {
  type: "plan" | "code";
  model?: string;
  /** Single-writer rule (KTD-4): true when the node is inside a split branch, so
   *  the review is advisory-only — no projection write, no authoritative verdict. */
  advisory?: boolean;
}

/** Verdict surface the step-review seam returns (mirrors reviewer.ts ReviewResult). */
export interface StepReviewSeamResult {
  verdict: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  review?: string;
  summary?: string;
}

/** The reserved context key carrying the active foreach instance (KTD-3, U3).
 *  Template node handlers (step-execute now; step-review in U5) read it to learn
 *  which step they operate on and the per-instance baseline/checkpoint state. */
export const FOREACH_ACTIVE_CONTEXT_KEY = "foreach:active";

/**
 * Reserved context key carrying the GOVERNING graph node id into the legacy
 * coding seams (column-agent plan U4, R4). The execute seam reads the seam node's
 * own id; the step-execute seam reads the foreach INSTANCE node id
 * (`<foreachId>#<i>:<templateNodeId>`) so the core column-agent resolver can map
 * it through template inheritance to the governing column's binding. The seam
 * stamps it into a per-run executor slot before driving the implementation pass,
 * so the binding the session runs under keys off the node's DECLARED IR column
 * — never the task's current board lane. Custom (non-seam) nodes never use this:
 * runGraphCustomNode receives its binding directly as a parameter (U3).
 */
export const SEAM_GOVERNING_NODE_CONTEXT_KEY = "workflow:seam-governing-node-id";

/**
 * Reserved context marker set by the split sub-walk (`runSplitJoin`) for the
 * duration of its branches' execution and cleared at the join (KTD-4, U5). A
 * `step-review` node that reads this as `true` is running inside a split branch,
 * so its verdict is **advisory-only** (single-writer rule): it never writes the
 * projection nor authors the routing verdict. `step-execute` is validator-forbidden
 * in splits, so only step-review needs to consult this.
 */
export const SPLIT_ACTIVE_CONTEXT_KEY = "split:active";

/**
 * Reserved context marker (KTD-11) the worktree-isolation foreach seeds into an
 * instance's context for ONE re-run after an integration-conflict, when the
 * template authored an explicit `outcome:integration-conflict` edge. Author nodes
 * read it to branch on the conflict; the sub-walk clears it after seeding so a
 * later clean rework does not re-surface a stale conflict signal.
 */
export const INTEGRATION_CONFLICT_CONTEXT_KEY = "integration:conflict";

/** Shape of the value stored under {@link FOREACH_ACTIVE_CONTEXT_KEY}. */
export interface ForeachActiveContext {
  foreachNodeId: string;
  stepIndex: number;
  instanceId: string;
  baselineSha?: string;
  checkpointId?: string;
  /** Latest authoritative step-review verdict for this instance (KTD-4/KTD-6, U5).
   *  Written by the step-review handler (non-advisory only); the foreach sub-walk
   *  persists it into the instance row. */
  verdict?: "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE";
  /**
   * True when the foreach template contains a `step-review` node (U6/KTD-4), so a
   * successful `step-execute` must NOT mark the step done — the review's APPROVE
   * verdict is the single authority that does (`markDoneOnSuccess: false`). The
   * foreach sub-walk sets this at instance entry; the step-execute seam reads it.
   */
  deferDoneToReview?: boolean;
  /**
   * Worktree-isolation (KTD-11, U10): the instance's OWN worktree path, branched
   * off the integration base. Set by the foreach sub-walk at instance entry under
   * `isolation: "worktree"`; the step-execute / step-review / RETHINK seams run
   * against THIS path instead of the task's main worktree. Absent under
   * `isolation: "shared"` (work lands directly in the main worktree). The file-scope
   * guard still fires for anything the instance session commits in this worktree
   * (the session machinery is unchanged — see executor stepExecute seam).
   */
  worktreePath?: string;
  /** Worktree-isolation (KTD-11, U10): the instance's OWN branch name (e.g.
   *  `fusion/<task>-step-<i>`). Set with {@link worktreePath}; the ordered
   *  integration stage lands this branch onto the task's main branch. */
  branchName?: string;
}

/**
 * Runs a custom (non-seam) prompt/script/gate node for a task — typically by
 * delegating to the WorkflowStep prompt-session/script machinery. Injected so
 * the graph layer stays engine-agnostic and unit-testable with fakes.
 */
export type WorkflowCustomNodeRunner = (
  node: WorkflowIrNode,
  task: TaskDetail,
  context: Record<string, unknown>,
) => Promise<WorkflowNodeResult>;

/** Resolve a node's seam name, or undefined for custom (non-seam) nodes. */
export function resolveSeamName(node: { config?: Record<string, unknown> }): WorkflowSeamName | undefined {
  const seam = node.config?.seam;
  if (seam === undefined) return undefined;
  if (
    seam === "planning" ||
    seam === "execute" ||
    seam === "review" ||
    seam === "merge" ||
    seam === "schedule" ||
    seam === "step-execute"
  ) {
    return seam;
  }
  throw new WorkflowIrError(`Unsupported workflow seam: ${String(seam)}`);
}

/**
 * Prompt/script handler: seam-configured nodes delegate to the legacy seam;
 * custom nodes run through the injected custom-node runner.
 */
export function createPromptLikeHandler(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
): WorkflowNodeHandler {
  return async (node, context) => {
    const seam = resolveSeamName(node);
    if (seam === "step-execute") {
      // Step-inversion (U3): step-execute resolves the active foreach instance
      // from the reserved context key and runs exactly that step. The active
      // context is set by the executor's foreach sub-walk on instance entry.
      const active = context.context[FOREACH_ACTIVE_CONTEXT_KEY] as
        | ForeachActiveContext
        | undefined;
      if (!active || typeof active.stepIndex !== "number") {
        throw new WorkflowIrError(
          `step-execute node '${node.id}' reached without an active foreach instance context`,
        );
      }
      if (!seams.stepExecute) {
        // Fail closed: a step-execute node with no seam wired must NOT silently
        // succeed — that would merge a task with no step work done.
        return { outcome: "failure", value: "step-execute-unwired" };
      }
      // Column-agent seam wiring (U4, R4): the GOVERNING node for a step-execute
      // session is the foreach INSTANCE node id, so the core resolver can map it
      // through template inheritance to the enclosing foreach's bound column (or
      // the template node's own column when it declares one). The template node id
      // is THIS node's id; the foreach node id + step index come from the active
      // instance context. Stamped so the seam threads it into the session build.
      context.context[SEAM_GOVERNING_NODE_CONTEXT_KEY] = instanceNodeId(
        active.foreachNodeId,
        active.stepIndex,
        node.id,
      );
      return seams.stepExecute(context.task, context.context);
    }
    if (seam) {
      // Column-agent seam wiring (U4, R4): for the execute seam the governing node
      // IS the seam node, so its declared column drives the binding. (Other seams
      // — planning/review/merge/schedule — stamp it too; only execute reads it.)
      context.context[SEAM_GOVERNING_NODE_CONTEXT_KEY] = node.id;
      return seams[seam]!(context.task, context.context);
    }
    if (!runCustomNode) {
      throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
    }
    return runCustomNode(node, context.task, context.context);
  };
}

/**
 * Gate handler. Two forms:
 * - Context gate (original scaffold contract): `config.expect` compared against
 *   a context key — pure, no execution.
 * - Executable gate: a gate node carrying a prompt/script config runs through
 *   the custom-node runner; its outcome decides whether the gate passes.
 */
export function createGateHandler(runCustomNode?: WorkflowCustomNodeRunner): WorkflowNodeHandler {
  return async (node, context) => {
    const expected = node.config?.expect;
    if (typeof expected === "string") {
      const actual = context.context[String(node.config?.contextKey ?? "outcome")];
      if (actual !== expected) {
        return { outcome: "failure", value: "gate-mismatch" };
      }
      return { outcome: "success" };
    }

    const hasExecutableConfig =
      typeof node.config?.prompt === "string" || typeof node.config?.scriptName === "string";
    if (hasExecutableConfig) {
      // Fail closed: an executable gate with no runner must NOT auto-pass — that
      // would silently bypass the gate and let the workflow continue. Mirror the
      // prompt/script handler, which throws in the same situation.
      if (!runCustomNode) {
        throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
      }
      return runCustomNode(node, context.task, context.context);
    }

    return { outcome: "success" };
  };
}

/** Per-step-review-node cap on UNAVAILABLE retries before routing the
 *  `outcome:unavailable` edge (KTD-4 — mirrors the in-session
 *  `planSpecUnavailableCounts` limiter posture, executor.ts ~7297). */
const STEP_REVIEW_UNAVAILABLE_RETRY_CAP = 2;

/** Resolve a step-review node's config (KTD-4). Defaults `type` to `code` (the
 *  enforcing review level — matches the legacy code-review authority). */
function resolveStepReviewConfig(node: WorkflowIrNode, advisory: boolean): StepReviewConfig {
  const raw = (node.config ?? {}) as { type?: unknown; model?: unknown };
  const type = raw.type === "plan" ? "plan" : "code";
  const model = typeof raw.model === "string" ? raw.model : undefined;
  return { type, model, advisory };
}

/**
 * Handler for the `step-review` node kind (KTD-4, U5). Resolves the active
 * foreach instance from {@link FOREACH_ACTIVE_CONTEXT_KEY}, detects the
 * single-writer/advisory posture from {@link SPLIT_ACTIVE_CONTEXT_KEY}, delegates
 * the actual review to `seams.stepReview` (which calls `reviewStep` under the
 * semaphore and — on an authoritative APPROVE — marks the step done through the
 * projection), and maps the verdict to the outcome value the
 * `outcome:approve|revise|rethink|unavailable` edges route on:
 *
 *   - APPROVE     → `value: "approve"`  (seam already marked the step done)
 *   - REVISE      → `value: "revise"`   (rework edge, no reset — revise in place)
 *   - RETHINK     → `value: "rethink"`  (rework edge whose traversal resets, U5 foreach)
 *   - UNAVAILABLE → bounded retry (cap {@link STEP_REVIEW_UNAVAILABLE_RETRY_CAP});
 *                   still unavailable → `value: "unavailable"`
 *
 * The verdict + reworkCount are persisted via the foreach sub-walk: the handler
 * writes the latest verdict back onto the active context so the sub-walk's
 * `saveInstanceState` carries it into the instance row (KTD-6).
 */
export function createStepReviewHandler(seams: WorkflowLegacySeams): WorkflowNodeHandler {
  return async (node, ctx) => {
    const active = ctx.context[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext | undefined;
    if (!active || typeof active.stepIndex !== "number") {
      throw new WorkflowIrError(
        `step-review node '${node.id}' reached without an active foreach instance context`,
      );
    }
    if (!seams.stepReview) {
      // Fail closed: a step-review node with no seam wired must NOT silently pass
      // — that would let an unreviewed step route forward (mirrors step-execute).
      return { outcome: "failure", value: "step-review-unwired" };
    }

    const advisory = ctx.context[SPLIT_ACTIVE_CONTEXT_KEY] === true;
    const config = resolveStepReviewConfig(node, advisory);

    // UNAVAILABLE bounded retry (KTD-4): re-invoke the reviewer up to the cap,
    // mirroring the in-session planSpecUnavailableCounts limiter. A usable verdict
    // short-circuits; exhaustion routes outcome:unavailable.
    let result: StepReviewSeamResult = { verdict: "UNAVAILABLE" };
    for (let attempt = 0; attempt <= STEP_REVIEW_UNAVAILABLE_RETRY_CAP; attempt++) {
      result = await seams.stepReview(ctx.task, ctx.context, config);
      if (result.verdict !== "UNAVAILABLE") break;
    }

    // Persist the verdict onto the active context so the foreach sub-walk writes
    // it into the instance row (KTD-6). Advisory (split-branch) reviews record the
    // verdict for audit but never become the authoritative instance verdict.
    if (!advisory) {
      active.verdict = result.verdict;
    }
    const patch: Record<string, unknown> = {
      [FOREACH_ACTIVE_CONTEXT_KEY]: active,
      [`node:${node.id}:verdict`]: result.verdict,
    };

    const value =
      result.verdict === "APPROVE"
        ? "approve"
        : result.verdict === "REVISE"
        ? "revise"
        : result.verdict === "RETHINK"
        ? "rethink"
        : "unavailable";

    return { outcome: "success", value, contextPatch: patch };
  };
}

// ── parse-steps node (U12, KTD-12) ──────────────────────────────────────────

/** The implicit default step-source artifact when a workflow declares no
 *  artifacts (mirrors core's IMPLICIT_DEFAULT_ARTIFACT). */
export const PARSE_STEPS_DEFAULT_ARTIFACT = "PROMPT.md";

/**
 * Engine-side dependencies the `parse-steps` handler needs (U12, KTD-12). All
 * injected so the handler stays unit-testable with fakes and the graph layer
 * stays engine-agnostic. The production wiring (executor.ts) reads the artifact
 * through the task-documents machinery (falling back to the task's PROMPT
 * content for the default `PROMPT.md` artifact), writes the parsed step list
 * through the graph-source projection (`updateTask({ steps })`), and reports
 * whether the foreach pin is already established (KTD-3 pin protection).
 */
export interface ParseStepsHandlerDeps {
  /**
   * Read an artifact's text content for a task. Resolves `undefined` when the
   * artifact does not exist (the handler maps that to `parse-error`). The
   * executor wires this to the task-documents read path with a PROMPT.md
   * fallback to the task's own PROMPT content.
   */
  readArtifact: (task: TaskDetail, key: string) => Promise<string | undefined>;
  /**
   * Write the canonical parsed step list through the projection sink (the single
   * graph-side step-list writer, KTD-12). All statuses are `pending`;
   * `dependsOn` is preserved. The executor wires this to
   * `store.updateTask(taskId, { steps })`.
   */
  writeSteps: (task: TaskDetail, steps: TaskStep[]) => Promise<void>;
  /**
   * Pin-protection probe (KTD-3): resolves true when a foreach has already
   * expanded for this task+run — either persisted instance rows exist OR a
   * foreach expanded earlier in this walk. Re-parsing after expansion is illegal
   * (it would silently desynchronize the pinned instance set), so the handler
   * fails with an audited `pin-mismatch` outcome. Optional — absent means no
   * pin established (always safe to parse).
   */
  hasExpandedForeach?: (task: TaskDetail) => Promise<boolean> | boolean;
  /** Optional audit sink: called with a stable reason code on every routable
   *  failure outcome (`parse-error`, `pin-mismatch`) so the run audit records it.
   *  Never throws into the handler. */
  audit?: (reason: string, detail: string) => void;
}

/**
 * Handler for the `parse-steps` node kind (U12, KTD-12). Reads the declared
 * artifact, resolves the parser from the core registry, runs it, and writes the
 * step list through the projection — the ONLY graph-side step-list writer.
 *
 * Outcomes:
 *   - unknown parser           → `outcome:failure value:"parse-error"` (audited)
 *   - missing artifact         → `outcome:failure value:"parse-error"` (audited)
 *   - parser throws            → `outcome:failure value:"parse-error"` (audited, never crashes)
 *   - clean empty parse        → `outcome:success value:"no-steps"` (routable; defaults to success)
 *   - foreach already expanded → `outcome:failure value:"pin-mismatch"` (audited, KTD-3)
 *   - steps parsed             → `outcome:success` (steps written through projection)
 */
export function createParseStepsHandler(deps: ParseStepsHandlerDeps): WorkflowNodeHandler {
  const audit = (reason: string, detail: string): void => {
    try {
      deps.audit?.(reason, detail);
    } catch {
      // Audit must never affect the run.
    }
  };

  return async (node, ctx) => {
    const cfg = (node.config ?? {}) as { artifact?: unknown; parser?: unknown };
    const parserId = typeof cfg.parser === "string" ? cfg.parser : "";
    const artifactKey =
      typeof cfg.artifact === "string" && cfg.artifact.trim() !== ""
        ? cfg.artifact
        : PARSE_STEPS_DEFAULT_ARTIFACT;

    // Pin protection (KTD-3): re-parsing after a foreach has expanded is illegal.
    try {
      if (deps.hasExpandedForeach && (await deps.hasExpandedForeach(ctx.task))) {
        audit(
          "pin-mismatch",
          `parse-steps node '${node.id}' reached after a foreach already expanded for task ${ctx.task.id}`,
        );
        return { outcome: "failure", value: "pin-mismatch" };
      }
    } catch (err) {
      // A pin-probe failure must fail closed (never silently re-parse).
      const message = err instanceof Error ? err.message : String(err);
      audit("pin-mismatch", `parse-steps node '${node.id}' pin probe failed: ${message}`);
      return { outcome: "failure", value: "pin-mismatch" };
    }

    // Resolve the parser from the registry (built-ins + plugin parsers, KTD-12).
    const parser = getStepParser(parserId);
    if (!parser) {
      audit(
        "parse-error",
        `parse-steps node '${node.id}' references unknown parser '${parserId}'`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    // Read the artifact content.
    let content: string | undefined;
    try {
      content = await deps.readArtifact(ctx.task, artifactKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit(
        "parse-error",
        `parse-steps node '${node.id}' artifact '${artifactKey}' read failed: ${message}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }
    if (content === undefined) {
      audit(
        "parse-error",
        `parse-steps node '${node.id}' artifact '${artifactKey}' not found for task ${ctx.task.id}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    // Run the parser; a throw (malformed artifact) maps to parse-error.
    let parsedSteps;
    try {
      parsedSteps = parser.parse(content).steps;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit(
        "parse-error",
        `parse-steps node '${node.id}' parser '${parserId}' threw: ${message}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    // Clean empty parse → routable no-steps outcome (defaults to success).
    if (parsedSteps.length === 0) {
      // Still write the (empty) projection so a re-parse is idempotent and the
      // foreach reads a definitive zero-step list.
      try {
        await deps.writeSteps(ctx.task, []);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit(
          "parse-error",
          `parse-steps node '${node.id}' failed to write empty step list: ${message}`,
        );
        return { outcome: "failure", value: "parse-error" };
      }
      return { outcome: "success", value: "no-steps" };
    }

    // Project the parsed steps onto the task step list — all pending, dependsOn
    // preserved. This is the single graph-side step-list write (KTD-12).
    const steps: TaskStep[] = parsedSteps.map((s) => {
      const step: TaskStep = { name: s.name, status: "pending" };
      if (s.dependsOn && s.dependsOn.length > 0) step.dependsOn = s.dependsOn;
      return step;
    });
    try {
      await deps.writeSteps(ctx.task, steps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit(
        "parse-error",
        `parse-steps node '${node.id}' failed to write ${steps.length} steps: ${message}`,
      );
      return { outcome: "failure", value: "parse-error" };
    }

    return { outcome: "success" };
  };
}

// ── code node (U14, KTD-15) ─────────────────────────────────────────────────

/**
 * Runs a `code` node's source against the harness contract (U14, KTD-15) and
 * returns the result mapped to graph behavior. Injected so the handler stays
 * engine-agnostic; the production wiring (executor.ts) drives the esbuild
 * compile + child-process runner in code-node-runner.ts, assembling the ctx
 * (task subset, walk context, declared artifacts, `foreach:active` instance) and
 * routing the returned `{ outcome, value, contextPatch, customFields }`.
 */
export type CodeNodeRunner = (
  node: WorkflowIrNode,
  task: TaskDetail,
  context: Record<string, unknown>,
) => Promise<WorkflowNodeResult>;

/**
 * Handler for the `code` node kind (U14, KTD-15). Delegates to the injected
 * runner. Fail-closed: a code node with no runner wired must NOT silently
 * succeed (it would route an unverified path forward) — it fails with an audited
 * value, mirroring the step-execute/step-review unwired posture.
 */
export function createCodeNodeHandler(runCode?: CodeNodeRunner): WorkflowNodeHandler {
  return async (node, ctx) => {
    if (!runCode) {
      return { outcome: "failure", value: "code-node-unwired" };
    }
    return runCode(node, ctx.task, ctx.context);
  };
}

export interface DefaultNodeHandlerDeps {
  /** parse-steps node deps (U12). When absent, a parse-steps node fails cleanly. */
  parseSteps?: ParseStepsHandlerDeps;
  /** code node runner (U14). When absent, a code node fails cleanly. */
  runCode?: CodeNodeRunner;
}

export function createDefaultNodeHandlers(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
  deps?: DefaultNodeHandlerDeps,
): Record<
  "prompt" | "script" | "gate" | "step-review" | "parse-steps" | "code",
  WorkflowNodeHandler
> {
  const promptLike = createPromptLikeHandler(seams, runCustomNode);
  // parse-steps without deps fails closed (would otherwise have no handler at
  // all and throw "No handler registered"); a clean failure is the safe posture.
  const parseSteps: WorkflowNodeHandler = deps?.parseSteps
    ? createParseStepsHandler(deps.parseSteps)
    : async () => ({ outcome: "failure", value: "parse-steps-unwired" });
  return {
    prompt: promptLike,
    script: promptLike,
    gate: createGateHandler(runCustomNode),
    "step-review": createStepReviewHandler(seams),
    "parse-steps": parseSteps,
    code: createCodeNodeHandler(deps?.runCode),
  };
}

/** Back-compat export: the original context-only gate handler. */
export const gateNodeHandler: WorkflowNodeHandler = createGateHandler();

export function createNoopLegacySeams(): WorkflowLegacySeams {
  const success = async (): Promise<WorkflowNodeResult> => ({ outcome: "success" });
  return {
    planning: success,
    execute: success,
    review: success,
    merge: success,
    schedule: success,
  };
}
