import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CreateInteractiveAiSessionFactory,
  CreateInteractiveAiSessionOptions,
  InteractiveAiSession,
  InteractiveAiSessionEvent,
  InteractiveAiSessionProgressEvent,
  PlanningQuestion,
  PluginContext,
} from "@fusion/core";
import { resolveDefaultInstallTargetRoot } from "../skill-installation.js";
import { getCePipelineStore, type CePipelineStore } from "../sync/pipeline-store.js";
import { createCeTaskWithLink } from "../sync/ce-task.js";
import { getDefaultModelId, getDefaultProvider, getDisabledStages } from "../settings.js";
import type { CeActivityTurn, CeSession, CeSessionStatus, CeSessionStore } from "./session-store.js";
import { getCeSessionStore } from "./session-store.js";
import { getStage, type CeStageDefinition } from "./stage-registry.js";

/**
 * The stage id whose `complete` payload carries a derived task list to land on
 * the board (U7). Its skill is `ce-work` (see the stage registry).
 */
export const WORK_STAGE_ID = "work";
const BRAINSTORM_STAGE_ID = "brainstorm";
const PLAN_STAGE_ID = "plan";

/**
 * CE provenance identity constants. Defined in `../sync/ce-task.ts` (so the
 * reconciler can reuse them without importing this module) and re-exported here
 * for existing consumers (index.ts, tests) that import them from the orchestrator.
 */
export { CE_PLUGIN_ID, CE_WORK_SOURCE_TYPE } from "../sync/ce-task.js";

/**
 * COMPLETION-PAYLOAD → TASKS CONTRACT (U7).
 *
 * The `work` stage's `complete` event `data` MAY carry a `tasks` array describing
 * the board tasks to create. Each entry needs at least a `description` (the only
 * required TaskCreateInput field); `title` and `column` are optional.
 *
 *   { artifact?: string, tasks?: Array<{ title?: string, description: string, column?: Column }> }
 *
 * A missing/empty `tasks` array is a clean no-op (no board tasks, no link rows).
 * Entries with a blank description are skipped (createTask would reject them).
 */
export interface CeDerivedTaskSpec {
  title?: string;
  description: string;
  column?: string;
}

/**
 * Default per-turn INACTIVITY timeout. A turn is treated as stalled only after
 * this long with NO live progress (thinking/text/tool activity) — a long but
 * actively-working turn is never killed. Without an onProgress-capable factory
 * (e.g. scripted test fakes), this degrades to a fixed per-turn timeout.
 */
const DEFAULT_TURN_TIMEOUT_MS = 120000;

/** Throttle for progress-driven SSE emits. */
const PROGRESS_EMIT_INTERVAL_MS = 500;
/** Durable liveness writes are intentionally coarser than live UI events. */
const PROGRESS_PERSIST_INTERVAL_MS = 5000;

/** Caps so a runaway turn cannot grow the live buffer unbounded. */
const MAX_ACTIVITY_TURNS = 200;
const MAX_ACTIVITY_TURN_CHARS = 16000;
/** Caps for the condensed activity trace persisted into history on settle. */
const MAX_PERSISTED_ACTIVITY_TURNS = 50;
const MAX_PERSISTED_ACTIVITY_TURN_CHARS = 4000;

const INTERACTIVE_AI_UNAVAILABLE_MESSAGE =
  "Session cannot be continued in this process: interactive AI sessions are unavailable (no factory on this context). Resume from a route context with the engine loaded.";

/** Excludes liveness-only timestamps so a drained heartbeat cannot supersede a terminal fallback. */
function durableSessionMutationFingerprint(session: CeSession): string {
  return JSON.stringify({
    id: session.id,
    stage: session.stage,
    status: session.status,
    currentQuestion: session.currentQuestion,
    conversationHistory: session.conversationHistory,
    projectId: session.projectId,
    artifactPath: session.artifactPath,
    error: session.error,
    turnIntervalMs: session.turnIntervalMs,
    createdAt: session.createdAt,
  });
}

/**
 * Observable event names emitted via `ctx.emitEvent`. The no-silent-loss
 * invariant requires that interrupt/error ALWAYS emit one of these AND persist
 * progress first.
 */
export const CE_EVENTS = {
  turn: "compound-engineering:session-turn",
  question: "compound-engineering:session-question",
  completed: "compound-engineering:session-completed",
  error: "compound-engineering:session-error",
  interrupted: "compound-engineering:session-interrupted",
} as const;

export class CeTurnTimeoutError extends Error {
  constructor(ms: number) {
    super(`CE session turn stalled: no agent activity for ${ms}ms`);
    this.name = "CeTurnTimeoutError";
  }
}

/*
FNXC:CompoundEngineeringConcurrency 2026-07-23-10:55:
Port of the planning turn-admission invariant (see FNXC:PlanningTurnAdmission in packages/dashboard/src/planning.ts, 2026-07-22).
Mobile view unmount/remount can re-submit an answer or resume while the previous turn is still running; without a guard the second entry rehydrates or re-prompts the SAME live handle, displacing the first turn — the displaced/disposed agent then yields an empty assistant message and the surviving turn dies with "Failed to parse agent response: AI returned no valid JSON".
Invariant: at most one turn (opening / answer / resume-rehydration) may be admitted per CE session at any time, reserved SYNCHRONOUSLY before any await and held until the turn fully settles (including detached background turns). A concurrent entry is rejected with CeTurnInProgressError (routes map it to HTTP 409) instead of displacing a healthy in-flight turn. cancel()/discard() intentionally bypass the guard — they are explicit teardown, and the displaced turn settles as interrupted through the existing no-silent-loss path.
*/
export class CeTurnInProgressError extends Error {
  constructor(sessionId: string) {
    super(
      `A turn is already in progress for CE session ${sessionId}. Wait for it to settle (watch the live output) instead of re-submitting.`,
    );
    this.name = "CeTurnInProgressError";
  }
}

/**
 * Which session backend a CE stage runs on (U9 seam).
 *
 * - `model` (default): the model-backed interactive AI session (existing path).
 * - `cli-agent`: a CLI agent adapter, run as a read-only one-shot per stage.
 *
 * The CE plugin threads this choice end-to-end (deps → resolver) per the
 * plugin-skills option-threading learning; the cli-agent one-shot wiring itself
 * lives engine-side in `@fusion/engine` (`runOneShotSession`).
 */
export type CeSessionExecutor =
  | { kind: "model" }
  | { kind: "cli-agent"; adapterId: string };

export interface OrchestratorDeps {
  ctx: PluginContext;
  /**
   * Interactive-session factory. Defaults to `ctx.createInteractiveAiSession`
   * (route contexts only); injectable for deterministic, scripted-fake tests.
   */
  createInteractiveAiSession?: CreateInteractiveAiSessionFactory;
  /** Project root used for the session cwd and artifact writes. */
  projectRoot?: string;
  /** Override the per-turn timeout (ms). */
  turnTimeoutMs?: number;
  /**
   * Session backend selector (U9). Defaults to `{ kind: "model" }`. When set to
   * `{ kind: "cli-agent", adapterId }`, CE sessions select the CLI-agent
   * one-shot executor. Threaded through to `resolveExecutor()` so callers can
   * route a CE stage onto a CLI adapter.
   *
   * DEVIATION (see U9 report): the cli-agent branch of the *live* CE stage loop
   * (replacing the interactive factory with one-shot turns inside
   * `startStage`/`continueStage`) is not yet wired — only the option seam and
   * its resolver contract land here. The engine-side one-shot runner is ready;
   * the remaining work is invoking it from the stage loop.
   */
  executor?: CeSessionExecutor;
}

/**
 * Skill discovery wiring (closes the U2 → U5 carry-forward).
 *
 * U2 proved a `PluginSkillContribution` is NOT auto-ingested by the engine
 * skill-resolver; a physical install onto a discoverable path is required, and
 * the plugin installs its bundled `ce-*` skills to a plugin-local directory
 * (`resolveDefaultInstallTargetRoot()`). The U4 seam now carries
 * `requestedSkillNames` + `additionalSkillPaths`, which the engine adapter
 * forwards into `createFnAgent` (`skills` + the loader's `additionalSkillPaths`).
 * So the orchestrator hands the live session BOTH the stage's skill id and the
 * install directory to discover it from — the session runs with `cwd` at the
 * real project root (where it reads context and writes artifacts), not at the
 * skills directory.
 */
export function resolveStageSkillPaths(): string[] {
  // The install target root holds `<skillId>/SKILL.md` for each installed skill;
  // passing it as an additional skill-discovery path makes the stage's skill
  // loadable while the session cwd stays on the project.
  return [resolveDefaultInstallTargetRoot()];
}

export interface StageSkillResolutionGuardResult {
  skillId: string;
  expectedSkillMdPaths: string[];
  found: boolean;
}

/**
 * FNXC:CompoundEngineering 2026-06-27-15:33:
 * Every interactive CE stage must launch with its registered `ce-*` skill both selected and discoverable. If the plugin-local install is missing `<skillId>/SKILL.md`, surface that before session creation so operators see a skill-loading fault instead of a silent degraded stage.
 */
export function checkStageSkillResolution(
  stage: CeStageDefinition,
  skillPaths: string[] = resolveStageSkillPaths(),
): StageSkillResolutionGuardResult {
  const expectedSkillMdPaths = skillPaths.map((root) => join(root, stage.skillId, "SKILL.md"));
  return {
    skillId: stage.skillId,
    expectedSkillMdPaths,
    found: expectedSkillMdPaths.some((skillMd) => existsSync(skillMd)),
  };
}

export function warnIfStageSkillMissing(
  logger: PluginContext["logger"],
  stage: CeStageDefinition,
  additionalSkillPaths: string[] = resolveStageSkillPaths(),
): StageSkillResolutionGuardResult {
  const guard = checkStageSkillResolution(stage, additionalSkillPaths);
  if (!guard.found) {
    logger.warn(
      `Compound Engineering stage '${stage.stageId}' requested skill '${stage.skillId}', but no SKILL.md was found on the plugin-local discovery paths. The session will still request the skill so the engine can resolve it if installation completes, but the current install appears missing.`,
      {
        stageId: stage.stageId,
        skillId: stage.skillId,
        expectedSkillMdPaths: guard.expectedSkillMdPaths,
        additionalSkillPaths,
      },
    );
  }
  return guard;
}

/**
 * Build the system prompt: instruct the agent to (a) apply the named ce-* skill
 * and (b) emit the JSON question/complete protocol the U4 seam parses.
 */
export function buildStageSystemPrompt(stage: CeStageDefinition): string {
  return [
    `You are running the Compound Engineering "${stage.stageId}" stage.`,
    `Apply the bundled skill "${stage.skillId}" (it has been loaded into this session).`,
    "",
    /*
     * FNXC:CompoundEngineering 2026-07-01-13:41:
     * CE dashboard stages may load rich skills that were authored for chat/terminal flows, including instructions to ask blocking questions or write prose summaries. The interactive session seam is stricter: every visible turn must translate any loaded-skill instruction into the structured question/complete JSON protocol so a newly launched Debug stage cannot become an Error session from non-JSON output.
     */
    "The JSON protocol below has priority over any loaded-skill instruction about asking questions, using blocking question tools, writing prose summaries, previewing commits/PRs, or ending with chat text: translate any loaded-skill instruction into a JSON question or JSON complete event.",
    "Drive the stage as an interactive question/answer flow. On every turn respond with ONLY a JSON object:",
    '  - To ask the user something: {"type":"question","data":{"id":"<unique>","type":"single_select|multi_select|text|confirm","question":"...","options":[{"id":"..","label":".."}]}}',
    '  - When the stage is finished: {"type":"complete","data":{"artifact":"<full markdown document>", ...}}',
    "No markdown fences, no prose outside the JSON object. Do not call user-question tools from this interactive stage; emit a JSON question instead.",
    "",
    "The user's reply arrives as {\"type\":\"answer\",\"questionId\":\"...\",\"response\":...}. The response takes one of three shapes:",
    "  - a direct answer to your question (an option id, array of option ids, text, or boolean),",
    '  - {"value": <direct answer>, "comment": "<guidance>"} — apply the answer AND incorporate the guidance into how you proceed,',
    '  - {"feedback": "<guidance only>"} — the user is steering rather than answering. Incorporate the feedback, adjust course, and either re-ask the question (possibly revised) or continue if the feedback resolves it.',
    "Steering feedback is first-class input: never ignore it, and acknowledge course corrections in your next question or output.",
  ].join("\n");
}

export interface StartStageOptions {
  /** Opening user message (the stage prompt / topic). */
  openingMessage: string;
  projectId?: string | null;
  /** Completed predecessor session whose artifact should be handed to the next stage. */
  sourceSessionId?: string;
  /**
   * Return as soon as the session row exists, with the turn running in the
   * background (the route posture — lets clients watch live working output
   * via push/poll instead of blocking on the whole turn).
   */
  detach?: boolean;
}

/** Result of a single orchestrator step (start / answer / resume). */
export interface CeStepResult {
  session: CeSession;
  /** The event the seam produced for this step, if a turn ran. */
  event?: InteractiveAiSessionEvent;
}

/**
 * Drives a stage's interactive skill session: streams thinking/text, surfaces
 * questions (persisted as `awaiting_input`), accepts answers, and on `complete`
 * writes the artifact to the stage's conventional location. On interrupt/error
 * it AUTO-SAVES progress and emits an observable event — never silent loss.
 *
 * Liveness uses the interval-relative rubric (CeSessionStore.isStale): a slow
 * turn is not misclassified stale.
 */
export class CeOrchestrator {
  private readonly ctx: PluginContext;
  private readonly store: CeSessionStore;
  private readonly pipelineStore: CePipelineStore;
  private readonly factory: CreateInteractiveAiSessionFactory | undefined;
  private readonly projectRoot: string;
  private readonly turnTimeoutMs: number;
  private readonly executor: CeSessionExecutor;
  /** Live in-memory session handles keyed by ce_session id. */
  private readonly live = new Map<string, InteractiveAiSession>();
  /** Mid-turn working output per session (transient; flushed to history on settle). */
  private readonly activity = new Map<string, CeActivityTurn[]>();
  /** Last progress timestamp per session (drives the inactivity watchdog). */
  private readonly lastProgressAt = new Map<string, number>();
  /** Last progress-driven emit per session (throttling). */
  private readonly lastProgressEmitAt = new Map<string, number>();
  /** Last liveness timestamp queued for durable persistence per session. */
  private readonly lastProgressPersistAt = new Map<string, number>();
  /** Sessions currently REPLAYING history (rehydrate) — progress suppressed. */
  private readonly replaying = new Set<string>();
  private readonly progressPersistence = new Map<string, Promise<void>>();
  /** Process-local terminal state used only when detached failure persistence itself fails. */
  private readonly detachedFailureFallbacks = new Map<string, { session: CeSession; durableFingerprint: string }>();
  /**
   * Sessions with an admitted in-flight turn (see CeTurnInProgressError),
   * keyed to a per-reservation token so a stale release (from a turn that
   * cancel()/discard() force-cleared) can never drop a NEWER turn's
   * reservation. Membership is toggled SYNCHRONOUSLY — no await between check
   * and add — so two overlapping entries cannot both pass the guard.
   */
  private readonly turnReservations = new Map<string, symbol>();

  constructor(deps: OrchestratorDeps) {
    this.ctx = deps.ctx;
    this.store = getCeSessionStore(deps.ctx);
    this.pipelineStore = getCePipelineStore(deps.ctx);
    this.factory = deps.createInteractiveAiSession ?? deps.ctx.createInteractiveAiSession;
    this.projectRoot = deps.projectRoot ?? deps.ctx.taskStore.getRootDir();
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.executor = deps.executor ?? { kind: "model" };
  }

  /**
   * Resolve the session backend for a CE stage (U9 seam). Threaded from
   * `OrchestratorDeps.executor`; defaults to the model-backed interactive
   * session. Exposed so the seam contract is directly assertable in tests and so
   * future stage-loop wiring has a single resolution point.
   */
  resolveExecutor(): CeSessionExecutor {
    return this.executor;
  }

  /**
   * Build the interactive-session options for a stage. The session runs with
   * `cwd` on the real project root (where it reads context and writes the stage
   * artifact) and is handed BOTH the stage's `ce-*` skill id and the plugin-local
   * install directory to discover it from — so the live agent actually loads the
   * bundled skill (closing the U2/U5 skill-discovery carry-forward). Model
   * provider/model are setting-gated (U9); omitted keys let the host pick defaults.
   */
  private async buildSessionOptions(
    stage: CeStageDefinition,
    sessionId: string,
    opts: Pick<CreateInteractiveAiSessionOptions, "allowAnswerQuestionIdDrift"> = {},
  ): Promise<Parameters<CreateInteractiveAiSessionFactory>[0]> {
    const defaultProvider = getDefaultProvider(this.ctx.settings);
    const defaultModelId = getDefaultModelId(this.ctx.settings);
    const additionalSkillPaths = resolveStageSkillPaths();
    warnIfStageSkillMissing(this.ctx.logger, stage, additionalSkillPaths);
    return {
      cwd: this.projectRoot,
      systemPrompt: await this.buildSystemPrompt(stage, sessionId),
      tools: "coding",
      requestedSkillNames: [stage.skillId],
      additionalSkillPaths,
      /*
       * FNXC:CompoundEngineering 2026-07-01-17:31:
       * Question-id drift tolerance is recovery-only. Fresh CE sessions keep the strict interactive seam guard so live/DB question divergence is surfaced immediately; rehydration enables the tolerance because the persisted session row is the recovery anchor after a restart.
       */
      ...(opts.allowAnswerQuestionIdDrift ? { allowAnswerQuestionIdDrift: true } : {}),
      onProgress: (event) => this.handleProgress(sessionId, event),
      ...(defaultProvider ? { defaultProvider } : {}),
      ...(defaultModelId ? { defaultModelId } : {}),
    };
  }

  private async buildSystemPrompt(stage: CeStageDefinition, sessionId: string): Promise<string> {
    const base = buildStageSystemPrompt(stage);
    const artifactPath = (await this.store.getAsync(sessionId))?.artifactPath;
    if (stage.stageId !== PLAN_STAGE_ID || !artifactPath) return base;
    return `${base}\n\nThe requirements-only unified plan is at ${artifactPath}. Read it and enrich that exact artifact in place to artifact_readiness: implementation-ready; do not create a sibling plan.`;
  }

  /**
   * Live mid-turn visibility. Accumulates streamed deltas into the session's
   * activity buffer (consecutive deltas of one kind merge into one turn; tool
   * markers are discrete), pokes the inactivity watchdog, and — throttled —
   * bumps the persisted liveness anchor and emits an observable turn event so
   * push clients refetch. Replay (rehydrate) progress is fully suppressed:
   * it reconstructs context, it is not new work.
   */
  private handleProgress(sessionId: string, event: InteractiveAiSessionProgressEvent): void {
    if (this.replaying.has(sessionId)) return;
    this.lastProgressAt.set(sessionId, Date.now());

    const turns = this.activity.get(sessionId) ?? [];
    if (!this.activity.has(sessionId)) this.activity.set(sessionId, turns);
    const now = new Date().toISOString();
    if (event.type === "tool") {
      if (event.phase === "start") {
        turns.push({ kind: "tool", text: event.name, at: now, done: false });
      } else {
        // Mark the most recent still-open tool turn with this name as done.
        for (let i = turns.length - 1; i >= 0; i--) {
          const t = turns[i];
          if (t.kind === "tool" && t.text === event.name && !t.done) {
            t.done = true;
            if (event.isError) t.isError = true;
            break;
          }
        }
      }
    } else {
      const last = turns[turns.length - 1];
      if (last && last.kind === event.type) {
        if (last.text.length < MAX_ACTIVITY_TURN_CHARS) {
          last.text = (last.text + event.delta).slice(0, MAX_ACTIVITY_TURN_CHARS);
        }
      } else {
        turns.push({ kind: event.type, text: event.delta.slice(0, MAX_ACTIVITY_TURN_CHARS), at: now });
      }
    }
    // Cap the buffer; drop oldest (the tail is what the user is watching).
    if (turns.length > MAX_ACTIVITY_TURNS) turns.splice(0, turns.length - MAX_ACTIVITY_TURNS);

    const nowMs = Date.now();
    if (nowMs - (this.lastProgressEmitAt.get(sessionId) ?? 0) >= PROGRESS_EMIT_INTERVAL_MS) {
      this.lastProgressEmitAt.set(sessionId, nowMs);
      this.ctx.emitEvent(CE_EVENTS.turn, { sessionId, kind: "progress" });
    }
    /*
     * FNXC:CompoundEngineeringConcurrency 2026-07-14-00:20:
     * Keep streamed UI progress responsive at 500 ms while coalescing PostgreSQL liveness writes to five seconds. The durable write touches timestamps only and every settling path drains the queue, preventing a late heartbeat from reverting history or terminal state.
     */
    if (nowMs - (this.lastProgressPersistAt.get(sessionId) ?? 0) >= PROGRESS_PERSIST_INTERVAL_MS) {
      this.queueProgressPersistence(sessionId, nowMs);
    }
  }

  private queueProgressPersistence(sessionId: string, at: number, force = false): void {
    if (!force && at - (this.lastProgressPersistAt.get(sessionId) ?? 0) < PROGRESS_PERSIST_INTERVAL_MS) return;
    if (at <= (this.lastProgressPersistAt.get(sessionId) ?? 0)) return;
    this.lastProgressPersistAt.set(sessionId, at);
    const previous = this.progressPersistence.get(sessionId) ?? Promise.resolve();
    const pending = previous
      .then(async () => {
        await this.store.touchActivityAsync(sessionId, at);
      })
      .catch((error: unknown) => {
        this.ctx.logger.warn(`Compound Engineering progress persistence failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.progressPersistence.get(sessionId) === pending) this.progressPersistence.delete(sessionId);
      });
    this.progressPersistence.set(sessionId, pending);
  }

  /** Flush the newest liveness timestamp before history/status changes or disposal. */
  private async drainProgressPersistence(sessionId: string): Promise<void> {
    const latest = this.lastProgressAt.get(sessionId);
    if (latest !== undefined) this.queueProgressPersistence(sessionId, latest, true);
    await (this.progressPersistence.get(sessionId) ?? Promise.resolve());
  }

  /** Read the in-flight working output for a session (route accessor). */
  getLiveActivity(sessionId: string): CeActivityTurn[] {
    return this.activity.get(sessionId) ?? [];
  }

  /**
   * Persist a condensed copy of the live activity buffer into history (so the
   * transcript keeps the working trace after the turn settles), then clear it.
   */
  private async flushActivity(sessionId: string): Promise<void> {
    await this.drainProgressPersistence(sessionId);
    const turns = this.activity.get(sessionId);
    this.activity.delete(sessionId);
    if (!turns || turns.length === 0) return;
    const condensed = turns.slice(-MAX_PERSISTED_ACTIVITY_TURNS).map((t) => ({
      ...t,
      text: t.text.slice(0, MAX_PERSISTED_ACTIVITY_TURN_CHARS),
    }));
    await this.store.appendHistoryAsync(sessionId, {
      role: "agent",
      text: JSON.stringify({ activity: { turns: condensed } }),
      at: new Date().toISOString(),
    });
  }

  /**
   * Inactivity watchdog: rejects only after `turnTimeoutMs` with NO progress.
   * Every progress event re-arms it, so a long actively-working turn survives;
   * with a non-streaming factory it degrades to a fixed per-turn timeout.
   */
  private createWatchdog(sessionId: string): { promise: Promise<never>; cancel(): void } {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.lastProgressAt.set(sessionId, Date.now());
    const promise = new Promise<never>((_, reject) => {
      const check = () => {
        if (cancelled) return;
        const elapsed = Date.now() - (this.lastProgressAt.get(sessionId) ?? 0);
        if (elapsed >= this.turnTimeoutMs) {
          reject(new CeTurnTimeoutError(this.turnTimeoutMs));
          return;
        }
        timer = globalThis.setTimeout(check, this.turnTimeoutMs - elapsed);
        timer.unref?.();
      };
      check();
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  /**
   * Synchronously reserve the session's single turn slot; returns the
   * idempotent release fn. Throws CeTurnInProgressError when a turn is already
   * admitted. Callers MUST release when the turn fully settles (finally on the
   * sync path, promise-finally on the detached path).
   */
  private reserveTurn(sessionId: string): () => void {
    if (this.turnReservations.has(sessionId)) {
      throw new CeTurnInProgressError(sessionId);
    }
    const token = Symbol(sessionId);
    this.turnReservations.set(sessionId, token);
    return () => {
      if (this.turnReservations.get(sessionId) === token) {
        this.turnReservations.delete(sessionId);
      }
    };
  }

  /**
   * Start a fresh session for a registered stage and run the opening turn.
   *
   * `detach: true` (the route posture) returns as soon as the session row
   * exists with the turn running in the background — the client converges via
   * push/poll and can watch the live working output. Errors during a detached
   * turn surface through session state (failSession/interruptSession), never
   * as an unhandled rejection. Validation errors still throw synchronously.
   */
  async start(stageId: string, opts: StartStageOptions): Promise<CeStepResult> {
    const stage = getStage(stageId);
    if (!stage) throw new Error(`Unknown CE stage: ${stageId}`);
    /*
     * FNXC:CompoundEngineering 2026-06-17-08:09:
     * Stage launch gating is opt-out: a registered CE stage launches unless operators explicitly list it in disabledStages. This keeps existing installs from rejecting newly appended stages because of stale enabledStages snapshots.
     */
    if (getDisabledStages(this.ctx.settings).includes(stageId)) {
      throw new Error(`CE stage is not enabled: ${stageId}`);
    }
    if (!this.factory) {
      throw new Error(
        "Interactive AI sessions are not available (createInteractiveAiSession is only injected on route contexts with the engine loaded).",
      );
    }

    /*
     * FNXC:CompoundEngineeringPlanning 2026-07-10-22:52:
     * Brainstorm creates the requirements-only unified plan. A same-project Plan session must carry the selected completed predecessor's safe docs/plans artifact path, accept it only while it remains requirements-only, and atomically claim it with row creation so concurrent starts cannot enrich the same file; absent a compatible handoff, legacy new-file behavior remains available.
     */
    const handoffArtifactPath = stageId === PLAN_STAGE_ID
      ? await this.findBrainstormHandoffArtifact(opts.projectId ?? null, opts.sourceSessionId)
      : null;
    const sessionInput = {
      stage: stageId,
      projectId: opts.projectId ?? null,
      artifactPath: handoffArtifactPath,
      turnIntervalMs: this.turnTimeoutMs,
    };
    const session = handoffArtifactPath
      ? await this.store.createWithPlanHandoffClaimAsync(sessionInput, handoffArtifactPath)
      : await this.store.createAsync(sessionInput);
    await this.store.appendHistoryAsync(session.id, { role: "user", text: opts.openingMessage, at: new Date().toISOString() });
    // The row is brand-new, so nothing can hold this reservation yet — but the
    // opening turn must HOLD it so an answer/resume racing in mid-turn is
    // rejected instead of displacing the live handle.
    const releaseTurn = this.reserveTurn(session.id);
    if (opts.detach) {
      let accepted: CeSession;
      try {
        accepted = await this.requireSession(session.id);
      } catch (err) {
        releaseTurn();
        throw err;
      }
      const turn = Promise.resolve()
        .then(() => this.runOpeningTurn(
          session.id,
          stage,
          opts.openingMessage,
          (active) => { accepted = active; },
        ))
        .finally(releaseTurn);
      this.detachTurn(() => accepted, "opening turn", turn);
      return { session: accepted };
    }
    try {
      return await this.runOpeningTurn(session.id, stage, opts.openingMessage);
    } finally {
      releaseTurn();
    }
  }

  /** Resolve the newest durable same-project Brainstorm handoff accepted for in-place Plan enrichment. */
  private async findBrainstormHandoffArtifact(projectId: string | null, sourceSessionId?: string): Promise<string | null> {
    const candidates = sourceSessionId
      ? [await this.store.getAsync(sourceSessionId)].filter((session): session is CeSession => Boolean(session))
      : await this.store.listAsync({ stage: BRAINSTORM_STAGE_ID });
    const candidate = candidates.find((session) => (
      session.stage === BRAINSTORM_STAGE_ID
      && session.status === "completed"
      && session.projectId === projectId
      && session.artifactPath
      && this.isSafePlanArtifactPath(session.artifactPath)
      && this.isRequirementsOnlyPlanArtifact(session.artifactPath)
    ));
    return candidate?.artifactPath ?? null;
  }

  private isRequirementsOnlyPlanArtifact(artifactPath: string): boolean {
    try {
      const prefix = readFileSync(artifactPath, "utf8").slice(0, 8 * 1024);
      return /(?:^|\n)artifact_contract:\s*ce-unified-plan\/v1\s*(?:\n|$)/.test(prefix)
        && /(?:^|\n)artifact_readiness:\s*requirements-only\s*(?:\n|$)/.test(prefix);
    } catch {
      return false;
    }
  }

  /** Handoffs may be absolute (current sessions) or root-relative (legacy rows), but must resolve inside docs/plans. */
  private isSafePlanArtifactPath(artifactPath: string): boolean {
    const planRoot = resolve(this.projectRoot, getStage(PLAN_STAGE_ID)?.artifactLocation ?? "docs/plans/");
    const candidate = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(this.projectRoot, artifactPath);
    const rel = relative(planRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "") return false;
    try {
      const realRel = relative(realpathSync(planRoot), realpathSync(candidate));
      return realRel !== "" && !realRel.startsWith("..") && !isAbsolute(realRel);
    } catch {
      return false;
    }
  }

  /** Create the live handle and run the opening turn. Never rejects. */
  private async runOpeningTurn(
    sessionId: string,
    stage: CeStageDefinition,
    openingMessage: string,
    onAccepted?: (session: CeSession) => void,
  ): Promise<CeStepResult> {
    let interactive;
    try {
      interactive = await this.factory!(await this.buildSessionOptions(stage, sessionId));
    } catch (err) {
      return { session: await this.failSession(sessionId, err), event: undefined };
    }
    this.live.set(sessionId, interactive.session);
    const active = await this.store.updateAsync(sessionId, { status: "active" }) ?? await this.requireSession(sessionId);
    onAccepted?.(active);
    return this.runTurn(sessionId, () => interactive.session.prompt(openingMessage), interactive.session);
  }

  /** Answer the awaiting question and continue the loop (detachable like start). */
  async answer(
    sessionId: string,
    questionId: string,
    response: unknown,
    opts: { detach?: boolean } = {},
  ): Promise<CeStepResult> {
    // Turn admission FIRST, synchronously — a re-submitted answer from a
    // remounted mobile view must be rejected before it can touch persisted
    // state or the live handle (see CeTurnInProgressError).
    const releaseTurn = this.reserveTurn(sessionId);
    // Once the detached background turn is armed, its promise-finally owns the
    // release; until then (validation throws) the finally below owns it.
    let releaseHandedOff = false;
    try {
      const session = await this.requireSession(sessionId);
      if (session.status !== "awaiting_input") {
        throw new Error(`Session ${sessionId} is not awaiting input (status=${session.status}).`);
      }
      // Validate the questionId BEFORE mutating any persisted state. A stale/wrong
      // questionId must NOT clear `currentQuestion` or flip status to active —
      // doing so would destroy the recovery anchor while the seam rejects the
      // mismatch, leaving the DB diverged from the live session. Reject cleanly and
      // leave `currentQuestion`/status intact so the session stays answerable.
      if (questionId !== session.currentQuestion?.id) {
        throw new Error(
          `Session ${sessionId} is awaiting question "${session.currentQuestion?.id ?? "(none)"}", not "${questionId}".`,
        );
      }
      const live = this.live.get(sessionId);
      if (!live && !this.factory) {
        throw new Error(INTERACTIVE_AI_UNAVAILABLE_MESSAGE);
      }

      if (opts.detach) {
        // If the process lost its live handle, rehydration can take time. Mirror
        // resume(detach): mark the row active immediately while the background
        // turn re-creates the handle and converges through persisted state.
        const accepted = await this.store.updateAsync(sessionId, { status: "active", currentQuestion: null, error: null }) ?? session;
        const turn = Promise.resolve()
          .then(() => this.runAnswerTurn(accepted, questionId, response))
          .finally(releaseTurn);
        releaseHandedOff = true;
        this.detachTurn(() => accepted, "answer turn", turn);
        return { session: accepted };
      }
      return await this.runAnswerTurn(session, questionId, response);
    } finally {
      if (!releaseHandedOff) releaseTurn();
    }
  }

  private async runAnswerTurn(session: CeSession, questionId: string, response: unknown): Promise<CeStepResult> {
    const sessionId = session.id;
    let live = this.live.get(sessionId);
    if (!live) {
      try {
        await this.rehydrate(session);
        live = this.live.get(sessionId);
        if (!live) {
          throw new Error(`Session ${sessionId} could not be rehydrated with a live handle.`);
        }
      } catch (err) {
        const interrupted = await this.interruptSession(sessionId, err);
        return {
          session: interrupted,
          event: { type: "error", data: { message: interrupted.error ?? "interrupted", cause: err } },
        };
      }
    }

    await this.store.appendHistoryAsync(sessionId, {
      role: "user",
      text: JSON.stringify({ answer: response, questionId }),
      at: new Date().toISOString(),
    });
    await this.store.updateAsync(sessionId, { status: "active", currentQuestion: null });
    return this.runTurn(sessionId, () => live.answer(questionId, response), live);
  }

  /**
   * Resume an `awaiting_input`, `interrupted`, or `error` session — and, crucially,
   * RE-ESTABLISH a live interactive handle so the resumed session can actually be
   * answered (Bug 5). After an interrupt/timeout the live handle was disposed and
   * removed from `this.live`; flipping persisted status back to `awaiting_input`
   * without a live handle was a dead end (resume → answer → "call resume() first").
   *
   * When a question is still pending and no live handle exists, we rehydrate via
   * the factory and REPLAY the persisted conversation history (opening message +
   * prior answers) to prime the fresh agent back to the current awaiting question,
   * repopulating `this.live`. Replay is side-effect-suppressed: it reconstructs
   * the agent's context only — no artifact writes, no event emits, no history
   * re-append (the DB already reflects the final state).
   *
   * If no factory is available (no live handle can ever be created in this
   * process), we DO NOT advertise a misleading answerable status: the session is
   * left `interrupted` with a clear error explaining it can't be continued here.
   */
  async resume(sessionId: string, opts: { detach?: boolean } = {}): Promise<CeStepResult> {
    // Turn admission FIRST, synchronously — a resume racing an in-flight
    // opening/answer turn (mobile re-entry, double-tapped Resume) must not
    // rehydrate a second live handle over the one the running turn is using.
    const releaseTurn = this.reserveTurn(sessionId);
    let releaseHandedOff = false;
    try {
      const session = await this.requireSession(sessionId);

      // Terminal / already-answerable-with-a-live-handle cases need no rehydration.
      if (session.status === "completed") return { session };
      if (session.status === "awaiting_input" && this.live.has(sessionId)) {
        return { session }; // already live + answerable.
      }

      // No pending question → nothing to re-prime to. Mark active so the caller can
      // re-run the turn with fresh input (retry for `error`, resume for others).
      if (!session.currentQuestion) {
        const next = await this.store.updateAsync(sessionId, { status: "active", error: null }) ?? session;
        return { session: next };
      }

      // A live handle already exists (e.g. interrupted but not disposed) — just
      // restore the answerable status.
      if (this.live.has(sessionId)) {
        const next = await this.store.updateAsync(sessionId, { status: "awaiting_input", error: null }) ?? session;
        return { session: next };
      }

      // Rehydration path: re-create the live session and replay history back to the
      // current question.
      if (!this.factory) {
        // Honest status: we cannot back an answerable state in this process, so do
        // not pretend the session is resumable here. Surface a clear error.
        const next =
          await this.store.updateAsync(sessionId, {
            status: "interrupted",
            error: INTERACTIVE_AI_UNAVAILABLE_MESSAGE,
          }) ?? session;
        return { session: next };
      }

      const rehydration = (async (): Promise<CeStepResult> => {
        try {
          await this.rehydrate(session);
        } catch (err) {
          // Rehydration failed — keep progress, surface the failure, do not
          // advertise an answerable status we can't back.
          return { session: await this.interruptSession(sessionId, err) };
        }
        const next = await this.store.updateAsync(sessionId, { status: "awaiting_input", error: null }) ?? session;
        return { session: next };
      })().finally(releaseTurn);
      releaseHandedOff = true;

      if (opts.detach) {
        // Rehydration replays the conversation against the live model and can be
        // slow; the route posture marks the session active and converges via
        // push/poll.
        const next = await this.store.updateAsync(sessionId, { status: "active", error: null }) ?? session;
        this.detachTurn(() => next, "rehydration", rehydration);
        return { session: next };
      }
      return await rehydration;
    } finally {
      if (!releaseHandedOff) releaseTurn();
    }
  }

  /**
   * Re-create a live interactive session and REPLAY the persisted conversation so
   * the fresh agent is primed back to the current awaiting question. Side effects
   * are suppressed: we drain the seam's events to advance the agent's context but
   * do NOT persist/emit/write — the DB already holds the authoritative final
   * state. Populates `this.live[session.id]` on success.
   */
  private async rehydrate(session: CeSession): Promise<void> {
    const stage = getStage(session.stage);
    if (!stage) throw new Error(`Unknown CE stage: ${session.stage}`);

    // Replay is side-effect-suppressed — including live progress, which would
    // otherwise re-stream the old turns' output as if it were new work.
    this.replaying.add(session.id);
    try {
      await this.rehydrateReplay(session, stage);
    } finally {
      this.replaying.delete(session.id);
    }
  }

  private async rehydrateReplay(session: CeSession, stage: CeStageDefinition): Promise<void> {
    const interactive = await this.factory!(
      await this.buildSessionOptions(stage, session.id, { allowAnswerQuestionIdDrift: true }),
    );
    const live = interactive.session;

    // Walk the recorded user turns in order. The FIRST user turn is the opening
    // message (raw text); each subsequent user turn is a serialized
    // {answer, questionId} produced by answer(). Drive the seam with each, and
    // drain exactly one event per drive to advance the agent's context — but
    // suppress all side effects (no persist/emit/artifact-write).
    const userTurns = session.conversationHistory.filter((t) => t.role === "user");
    try {
      for (let i = 0; i < userTurns.length; i++) {
        const turn = userTurns[i];
        if (i === 0) {
          await live.prompt(turn.text);
        } else {
          const parsed = this.parseAnswerTurn(turn.text);
          if (!parsed) continue; // tolerate non-answer user turns.
          await live.answer(parsed.questionId, parsed.answer);
        }
        // Drain the agent's response for this turn to keep the seam in lockstep,
        // but DISCARD it — replay reconstructs context, it does not re-run the
        // turn loop's side effects.
        await live.nextEvent();
      }
    } catch (err) {
      // Replay failed mid-way — dispose the half-primed handle so we don't leave
      // a broken live session behind, then propagate.
      try {
        live.dispose();
      } catch {
        // best-effort
      }
      throw err;
    }

    this.live.set(session.id, live);
  }

  /** Parse a serialized `{ answer, questionId }` user turn produced by answer(). */
  private parseAnswerTurn(text: string): { questionId: string; answer: unknown } | undefined {
    try {
      const obj = JSON.parse(text) as { answer?: unknown; questionId?: unknown };
      if (typeof obj?.questionId === "string") {
        return { questionId: obj.questionId, answer: obj.answer };
      }
    } catch {
      // not a JSON answer turn
    }
    return undefined;
  }

  /** Read-through accessor for routes. */
  async getState(sessionId: string): Promise<CeSession | undefined> {
    const durable = await this.store.getAsync(sessionId);
    return this.resolveDetachedFailureFallback(durable, sessionId);
  }

  /**
   * FNXC:CompoundEngineeringConcurrency 2026-07-14-01:10:
   * Session collections must expose the same effective terminal fallback as single-session polling. Apply stage/project constraints in PostgreSQL, overlay detached terminal failures, and only then evaluate status so a durably launching row cannot remain visible as running or disappear from an error-filtered list.
   */
  async listStates(
    filter: { status?: CeSessionStatus; stage?: string; projectId?: string } = {},
  ): Promise<CeSession[]> {
    const durable = await this.store.listAsync({ stage: filter.stage, projectId: filter.projectId });
    const effective = durable.map((session) => this.resolveDetachedFailureFallback(session) ?? session);
    return filter.status ? effective.filter((session) => session.status === filter.status) : effective;
  }

  private resolveDetachedFailureFallback(durable: CeSession | undefined, sessionId = durable?.id): CeSession | undefined {
    if (!durable) {
      if (sessionId) this.detachedFailureFallbacks.delete(sessionId);
      return undefined;
    }
    const fallback = this.detachedFailureFallbacks.get(durable.id);
    if (!fallback) return durable;
    if (durableSessionMutationFingerprint(durable) !== fallback.durableFingerprint) {
      this.detachedFailureFallbacks.delete(durable.id);
      return durable;
    }
    return fallback.session;
  }

  /**
   * Cancel a session: stop any live in-process handle but keep the persisted row
   * for inspection/resume by marking it `interrupted`. Unlike discard(), cancel
   * preserves the conversation and progress; discard stops the handle AND deletes
   * the row. Terminal sessions are idempotent no-ops.
   */
  async cancel(sessionId: string): Promise<CeSession | undefined> {
    const session = await this.store.getAsync(sessionId);
    if (!session) return undefined;
    if (session.status === "completed" || session.status === "error" || session.status === "interrupted") {
      return session;
    }

    // Preserve no-silent-loss ordering: interruptSession flushes live activity
    // before disposeLive clears the transient buffers (same as runTurn failure).
    const interrupted = await this.interruptSession(sessionId, new Error("Cancelled by user"));
    this.disposeLive(sessionId);
    // Explicit teardown clears the turn reservation: the displaced turn's agent
    // is disposed (it settles as interrupted), and the session must accept a
    // fresh turn even if that turn's own release was wedged (e.g. a hung
    // rehydration, which runs without a watchdog).
    this.turnReservations.delete(sessionId);
    return interrupted;
  }

  /**
   * Discard a session: dispose any live in-process handle (so an in-flight
   * agent doesn't keep running unobserved) and delete the persisted row.
   * Returns false when the session doesn't exist. Pipeline-link rows are NOT
   * touched — board tasks the session landed keep their provenance records.
   */
  async discard(sessionId: string): Promise<boolean> {
    await this.drainProgressPersistence(sessionId);
    this.disposeLive(sessionId);
    // Same reservation clear as cancel(): the row is going away; never leave a
    // stale reservation behind for a reused orchestrator instance.
    this.turnReservations.delete(sessionId);
    const deleted = await this.store.deleteAsync(sessionId);
    if (deleted) this.detachedFailureFallbacks.delete(sessionId);
    return deleted;
  }

  /**
   * Run one turn behind a timeout race, persist the resulting event, and on a
   * turn-level failure auto-save + emit. The `driver` performs the prompt/answer
   * against the live session; we then pull exactly one event.
   */
  private async runTurn(
    sessionId: string,
    driver: () => Promise<void>,
    live: InteractiveAiSession,
  ): Promise<CeStepResult> {
    let event: InteractiveAiSessionEvent;
    const watchdog = this.createWatchdog(sessionId);
    try {
      event = await Promise.race([
        (async () => {
          await driver();
          return live.nextEvent();
        })(),
        watchdog.promise,
      ]);
    } catch (err) {
      // Timeout or driver throw → auto-save as interrupted (progress preserved)
      // and emit an observable event. Never silent loss.
      watchdog.cancel();
      const session = await this.interruptSession(sessionId, err);
      this.disposeLive(sessionId);
      return { session, event: { type: "error", data: { message: session.error ?? "interrupted", cause: err } } };
    }
    watchdog.cancel();

    let session: CeSession;
    try {
      session = await this.applyEvent(sessionId, event);
    } catch (error) {
      session = await this.failSession(sessionId, error);
      this.disposeLive(sessionId);
      return {
        session,
        event: { type: "error", data: { message: session.error ?? "artifact persistence failed", cause: error } },
      };
    }
    if (event.type === "complete" || event.type === "error") {
      this.disposeLive(sessionId);
    }
    // Work bridge (U7): the work stage's completion payload lands derived tasks
    // on the board, tagged CE-originated + recorded as pipeline links. Outbound
    // only — created tasks then run the NORMAL lifecycle with no plugin hooks.
    if (event.type === "complete" && session.stage === WORK_STAGE_ID) {
      await this.landWorkTasks(session, event.data);
    }
    return { session, event };
  }

  /** Persist a seam event onto the session row + emit the matching observable event. */
  private async applyEvent(sessionId: string, event: InteractiveAiSessionEvent): Promise<CeSession> {
    await this.drainProgressPersistence(sessionId);
    // The turn settled — persist its working trace into history (so the
    // transcript keeps it) BEFORE the settling record, then clear the buffer.
    if (event.type === "question" || event.type === "complete" || event.type === "error") {
      await this.flushActivity(sessionId);
    }
    switch (event.type) {
      case "thinking":
      case "text": {
        await this.store.appendHistoryAsync(sessionId, { role: "agent", text: event.data, at: new Date().toISOString() });
        const s = await this.store.updateAsync(sessionId, { status: "active" }) ?? await this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.turn, { sessionId, kind: event.type });
        return s;
      }
      case "question": {
        const q: PlanningQuestion = event.data;
        await this.store.appendHistoryAsync(sessionId, {
          role: "agent",
          text: JSON.stringify({ question: q }),
          at: new Date().toISOString(),
        });
        const s = await this.store.updateAsync(sessionId, { status: "awaiting_input", currentQuestion: q }) ?? await this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.question, { sessionId, questionId: q.id });
        return s;
      }
      case "complete": {
        const artifactPath = await this.writeArtifact(sessionId, event.data);
        await this.store.appendHistoryAsync(sessionId, {
          role: "agent",
          text: JSON.stringify({ complete: true }),
          at: new Date().toISOString(),
        });
        const s =
          await this.store.updateAsync(sessionId, { status: "completed", currentQuestion: null, artifactPath }) ??
          await this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.completed, { sessionId, artifactPath });
        return s;
      }
      case "error": {
        const message = event.data.message;
        // Error preserves progress (currentQuestion/history untouched) so retry
        // can resume. Status error; observable event emitted.
        const s = await this.store.updateAsync(sessionId, { status: "error", error: message }) ?? await this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.error, { sessionId, message });
        return s;
      }
    }
  }

  /**
   * Work bridge (U7). Read the derived task list from the work stage's
   * completion payload, create each as a board task tagged CE-originated, and
   * record a pipeline-link row resolving task→pipeline/stage/artifact. Zero
   * derived tasks is a clean no-op (no board tasks, no orphan link rows). The
   * created tasks then run the normal lifecycle — no hooks attached here (U8).
   */
  private async landWorkTasks(session: CeSession, data: unknown): Promise<void> {
    const specs = this.extractTaskSpecs(data);
    if (specs.length === 0) return;

    // The session is the CE pipeline run; its id is the stable pipeline id the
    // link rows (and U8's state machine) address.
    const cePipelineId = session.id;
    const ceStageId = session.stage;
    const ceArtifactPath = session.artifactPath ?? null;

    // Seed the CE-pipeline STATE record (U8). This is the pipeline's OWN state
    // machine, distinct from the board task columns it will spawn. The pipeline
    // is "running" at this stage until a board signal advances it.
    await this.pipelineStore.upsertStateAsync({
      cePipelineId,
      currentStage: ceStageId,
      status: "running",
      lastArtifactPath: ceArtifactPath,
    });

    for (const spec of specs) {
      const description = spec.description.trim();
      if (!description) continue; // createTask rejects blank descriptions.

      // Shared contract: create the CE-tagged board task AND its authoritative
      // pipeline-link row (FN-5719) in one place (see createCeTaskWithLink).
      await createCeTaskWithLink(this.ctx.taskStore, this.pipelineStore, {
        title: spec.title,
        description,
        column: spec.column,
        cePipelineId,
        ceStageId,
        ceArtifactPath,
      });
    }
  }

  /** Parse the `{ tasks: [...] }` completion-payload contract; tolerant of shape. */
  private extractTaskSpecs(data: unknown): CeDerivedTaskSpec[] {
    if (!data || typeof data !== "object") return [];
    const raw = (data as { tasks?: unknown }).tasks;
    if (!Array.isArray(raw)) return [];
    const specs: CeDerivedTaskSpec[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const description = typeof e.description === "string" ? e.description : "";
      if (!description.trim()) continue;
      specs.push({
        description,
        title: typeof e.title === "string" ? e.title : undefined,
        column: typeof e.column === "string" ? e.column : undefined,
      });
    }
    return specs;
  }

  /** Persist `interrupted` with progress preserved and emit. */
  private async interruptSession(sessionId: string, cause: unknown): Promise<CeSession> {
    // Keep the working trace: an interrupted turn's output is exactly what the
    // user needs to see to understand where it stopped.
    await this.flushActivity(sessionId);
    const message = cause instanceof Error ? cause.message : String(cause);
    return this.persistTerminalState(sessionId, "interrupted", message);
  }

  /** Persist `error` (session-create failure path) and emit. */
  private async failSession(sessionId: string, cause: unknown): Promise<CeSession> {
    await this.drainProgressPersistence(sessionId);
    const message = cause instanceof Error ? cause.message : String(cause);
    return this.persistTerminalState(sessionId, "error", message);
  }

  /**
   * FNXC:CompoundEngineeringConcurrency 2026-07-14-00:58:
   * Every detached terminal transition must be observable even when PostgreSQL returns no updated row. Error and interrupted writes share one process-local fallback that ignores heartbeat-only timestamp movement but yields to any later semantic durable mutation.
   */
  private async persistTerminalState(
    sessionId: string,
    status: "error" | "interrupted",
    message: string,
  ): Promise<CeSession> {
    const durable = await this.store.updateAsync(sessionId, { status, error: message }) ?? await this.requireSession(sessionId);
    if (durable.status === "completed" || durable.status === "error" || durable.status === "interrupted") {
      if (durable.status === status) {
        this.ctx.emitEvent(status === "error" ? CE_EVENTS.error : CE_EVENTS.interrupted, { sessionId, message });
      }
      return durable;
    }
    return this.retainTerminalFallback(durable, status, message);
  }

  private retainTerminalFallback(
    durable: CeSession,
    status: "error" | "interrupted",
    message: string,
  ): CeSession {
    const failedAt = Date.now();
    const fallback: CeSession = {
      ...durable,
      status,
      error: message,
      lastActivityAt: failedAt,
      updatedAt: new Date(failedAt).toISOString(),
    };
    this.detachedFailureFallbacks.set(durable.id, {
      durableFingerprint: durableSessionMutationFingerprint(durable),
      session: fallback,
    });
    this.disposeLive(durable.id);
    this.ctx.emitEvent(status === "error" ? CE_EVENTS.error : CE_EVENTS.interrupted, {
      sessionId: durable.id,
      message,
    });
    return fallback;
  }

  /**
   * Write the stage artifact to its conventional location (R10). Accepts either
   * a `{ artifact: string }` payload or a raw string. Returns the absolute path.
   */
  private async writeArtifact(sessionId: string, data: unknown): Promise<string> {
    const session = await this.requireSession(sessionId);
    const stage = getStage(session.stage);
    const location = stage?.artifactLocation ?? `docs/ce/${session.stage}/`;
    const content = this.extractArtifactContent(data);

    const target = session.stage === PLAN_STAGE_ID
      && session.artifactPath
      && this.isSafePlanArtifactPath(session.artifactPath)
      ? session.artifactPath
      : location.endsWith("/")
        ? join(location, `${session.stage}-${session.id}.md`)
        : location;
    const abs = isAbsolute(target) ? target : join(this.projectRoot, target);
    mkdirSync(dirname(abs), { recursive: true });
    if (session.stage === PLAN_STAGE_ID && session.artifactPath === target) {
      if (!/(?:^|\n)artifact_contract:\s*ce-unified-plan\/v1\s*(?:\n|$)/.test(content)
        || !/(?:^|\n)artifact_readiness:\s*implementation-ready\s*(?:\n|$)/.test(content)) {
        throw new Error("Plan completion must produce an implementation-ready ce-unified-plan/v1 artifact");
      }
      const temporary = `${abs}.tmp-${session.id}`;
      try {
        writeFileSync(temporary, content, "utf-8");
        renameSync(temporary, abs);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    } else {
      writeFileSync(abs, content, "utf-8");
    }
    return abs;
  }

  private extractArtifactContent(data: unknown): string {
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "artifact" in data) {
      const a = (data as { artifact: unknown }).artifact;
      if (typeof a === "string") return a;
    }
    return JSON.stringify(data, null, 2);
  }

  private async requireSession(sessionId: string): Promise<CeSession> {
    const s = await this.store.getAsync(sessionId);
    if (!s) throw new Error(`CE session not found: ${sessionId}`);
    return s;
  }

  /**
   * FNXC:CompoundEngineeringConcurrency 2026-07-14-01:57:
   * Route-detached model work must capture its accepted semantic state before arming the background rejection handler. If PostgreSQL reads and the terminal write both fail afterward, that snapshot seeds the shared process-local fallback; heartbeat timestamps remain non-semantic and later durable semantic mutations still supersede it.
   */
  private detachTurn(accepted: () => CeSession, label: string, operation: Promise<unknown>): void {
    const sessionId = accepted().id;
    void operation.catch(async (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.ctx.logger.error(`Compound Engineering detached ${label} failed for ${sessionId}: ${message}`);
      let session = accepted();
      try {
        const current = await this.store.getAsync(sessionId);
        if (!current) return;
        session = current;
      } catch (readError) {
        this.ctx.logger.error(`Compound Engineering could not read detached ${label} failure state for ${sessionId}: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      if (session.status === "completed" || session.status === "error" || session.status === "interrupted") return;
      try {
        await this.failSession(sessionId, cause);
      } catch (persistError) {
        this.ctx.logger.error(`Compound Engineering could not persist detached ${label} failure for ${sessionId}: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
        this.retainTerminalFallback(session, "error", message);
      }
    });
  }

  private disposeLive(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live) {
      try {
        live.dispose();
      } catch {
        // best-effort
      }
      this.live.delete(sessionId);
    }
    this.activity.delete(sessionId);
    this.lastProgressAt.delete(sessionId);
    this.lastProgressEmitAt.delete(sessionId);
    this.lastProgressPersistAt.delete(sessionId);
  }
}
