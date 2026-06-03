import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type {
  CreateInteractiveAiSessionFactory,
  InteractiveAiSession,
  InteractiveAiSessionEvent,
  PlanningQuestion,
  PluginContext,
} from "@fusion/core";
import { resolveDefaultInstallTargetRoot } from "../skill-installation.js";
import { getCePipelineStore, type CePipelineStore } from "../sync/pipeline-store.js";
import { createCeTaskWithLink } from "../sync/ce-task.js";
import { getDefaultModelId, getDefaultProvider, getEnabledStages } from "../settings.js";
import type { CeSession, CeSessionStore } from "./session-store.js";
import { getCeSessionStore } from "./session-store.js";
import { getStage, type CeStageDefinition } from "./stage-registry.js";

/**
 * The stage id whose `complete` payload carries a derived task list to land on
 * the board (U7). Its skill is `ce-work` (see the stage registry).
 */
export const WORK_STAGE_ID = "work";

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

/** Default per-turn timeout. A turn that exceeds this is treated as a stall. */
const DEFAULT_TURN_TIMEOUT_MS = 120000;

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
    super(`CE session turn timed out after ${ms}ms`);
    this.name = "CeTurnTimeoutError";
  }
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    globalThis.setTimeout(() => reject(new CeTurnTimeoutError(ms)), ms).unref?.();
  });
}

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

/**
 * Build the system prompt: instruct the agent to (a) apply the named ce-* skill
 * and (b) emit the JSON question/complete protocol the U4 seam parses.
 */
export function buildStageSystemPrompt(stage: CeStageDefinition): string {
  return [
    `You are running the Compound Engineering "${stage.stageId}" stage.`,
    `Apply the bundled skill "${stage.skillId}" (it has been loaded into this session).`,
    "",
    "Drive the stage as an interactive question/answer flow. On every turn respond with ONLY a JSON object:",
    '  - To ask the user something: {"type":"question","data":{"id":"<unique>","type":"single_select|multi_select|text|confirm","question":"...","options":[{"id":"..","label":".."}]}}',
    '  - When the stage is finished: {"type":"complete","data":{"artifact":"<full markdown document>", ...}}',
    "No markdown fences, no prose outside the JSON object.",
  ].join("\n");
}

export interface StartStageOptions {
  /** Opening user message (the stage prompt / topic). */
  openingMessage: string;
  projectId?: string | null;
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
  /** Live in-memory session handles keyed by ce_session id. */
  private readonly live = new Map<string, InteractiveAiSession>();

  constructor(deps: OrchestratorDeps) {
    this.ctx = deps.ctx;
    this.store = getCeSessionStore(deps.ctx);
    this.pipelineStore = getCePipelineStore(deps.ctx);
    this.factory = deps.createInteractiveAiSession ?? deps.ctx.createInteractiveAiSession;
    this.projectRoot = deps.projectRoot ?? deps.ctx.taskStore.getRootDir();
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  /**
   * Build the interactive-session options for a stage. The session runs with
   * `cwd` on the real project root (where it reads context and writes the stage
   * artifact) and is handed BOTH the stage's `ce-*` skill id and the plugin-local
   * install directory to discover it from — so the live agent actually loads the
   * bundled skill (closing the U2/U5 skill-discovery carry-forward). Model
   * provider/model are setting-gated (U9); omitted keys let the host pick defaults.
   */
  private buildSessionOptions(stage: CeStageDefinition): Parameters<CreateInteractiveAiSessionFactory>[0] {
    const defaultProvider = getDefaultProvider(this.ctx.settings);
    const defaultModelId = getDefaultModelId(this.ctx.settings);
    return {
      cwd: this.projectRoot,
      systemPrompt: buildStageSystemPrompt(stage),
      tools: "coding",
      requestedSkillNames: [stage.skillId],
      additionalSkillPaths: resolveStageSkillPaths(),
      ...(defaultProvider ? { defaultProvider } : {}),
      ...(defaultModelId ? { defaultModelId } : {}),
    };
  }

  /** Start a fresh session for a registered stage and run the opening turn. */
  async start(stageId: string, opts: StartStageOptions): Promise<CeStepResult> {
    const stage = getStage(stageId);
    if (!stage) throw new Error(`Unknown CE stage: ${stageId}`);
    // Setting-gated launch (U9): only stages the operator enabled may launch.
    if (!getEnabledStages(this.ctx.settings).includes(stageId)) {
      throw new Error(`CE stage is not enabled: ${stageId}`);
    }
    if (!this.factory) {
      throw new Error(
        "Interactive AI sessions are not available (createInteractiveAiSession is only injected on route contexts with the engine loaded).",
      );
    }

    let session = this.store.create({
      stage: stageId,
      projectId: opts.projectId ?? null,
      turnIntervalMs: this.turnTimeoutMs,
    });
    this.store.appendHistory(session.id, { role: "user", text: opts.openingMessage, at: new Date().toISOString() });

    let interactive;
    try {
      interactive = await this.factory(this.buildSessionOptions(stage));
    } catch (err) {
      return { session: this.failSession(session.id, err), event: undefined };
    }
    this.live.set(session.id, interactive.session);
    session = this.store.update(session.id, { status: "active" }) ?? session;

    return this.runTurn(session.id, () => interactive.session.prompt(opts.openingMessage), interactive.session);
  }

  /** Answer the awaiting question and continue the loop. */
  async answer(sessionId: string, questionId: string, response: unknown): Promise<CeStepResult> {
    const session = this.requireSession(sessionId);
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
    if (!live) {
      throw new Error(`Session ${sessionId} has no live handle in this process; call resume() first.`);
    }
    this.store.appendHistory(sessionId, {
      role: "user",
      text: JSON.stringify({ answer: response, questionId }),
      at: new Date().toISOString(),
    });
    this.store.update(sessionId, { status: "active", currentQuestion: null });
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
  async resume(sessionId: string): Promise<CeStepResult> {
    const session = this.requireSession(sessionId);

    // Terminal / already-answerable-with-a-live-handle cases need no rehydration.
    if (session.status === "completed") return { session };
    if (session.status === "awaiting_input" && this.live.has(sessionId)) {
      return { session }; // already live + answerable.
    }

    // No pending question → nothing to re-prime to. Mark active so the caller can
    // re-run the turn with fresh input (retry for `error`, resume for others).
    if (!session.currentQuestion) {
      const next = this.store.update(sessionId, { status: "active", error: null }) ?? session;
      return { session: next };
    }

    // A live handle already exists (e.g. interrupted but not disposed) — just
    // restore the answerable status.
    if (this.live.has(sessionId)) {
      const next = this.store.update(sessionId, { status: "awaiting_input", error: null }) ?? session;
      return { session: next };
    }

    // Rehydration path: re-create the live session and replay history back to the
    // current question.
    if (!this.factory) {
      // Honest status: we cannot back an answerable state in this process, so do
      // not pretend the session is resumable here. Surface a clear error.
      const next =
        this.store.update(sessionId, {
          status: "interrupted",
          error:
            "Session cannot be continued in this process: interactive AI sessions are unavailable (no factory on this context). Resume from a route context with the engine loaded.",
        }) ?? session;
      return { session: next };
    }

    try {
      await this.rehydrate(session);
    } catch (err) {
      // Rehydration failed — keep progress, surface the failure, do not advertise
      // an answerable status we can't back.
      const next = this.interruptSession(sessionId, err);
      return { session: next };
    }

    const next = this.store.update(sessionId, { status: "awaiting_input", error: null }) ?? session;
    return { session: next };
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

    const interactive = await this.factory!(this.buildSessionOptions(stage));
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
  getState(sessionId: string): CeSession | undefined {
    return this.store.get(sessionId);
  }

  /**
   * Discard a session: dispose any live in-process handle (so an in-flight
   * agent doesn't keep running unobserved) and delete the persisted row.
   * Returns false when the session doesn't exist. Pipeline-link rows are NOT
   * touched — board tasks the session landed keep their provenance records.
   */
  discard(sessionId: string): boolean {
    this.disposeLive(sessionId);
    return this.store.delete(sessionId);
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
    try {
      event = await Promise.race([
        (async () => {
          await driver();
          return live.nextEvent();
        })(),
        timeoutAfter(this.turnTimeoutMs),
      ]);
    } catch (err) {
      // Timeout or driver throw → auto-save as interrupted (progress preserved)
      // and emit an observable event. Never silent loss.
      const session = this.interruptSession(sessionId, err);
      this.disposeLive(sessionId);
      return { session, event: { type: "error", data: { message: session.error ?? "interrupted", cause: err } } };
    }

    const session = this.applyEvent(sessionId, event);
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
  private applyEvent(sessionId: string, event: InteractiveAiSessionEvent): CeSession {
    switch (event.type) {
      case "thinking":
      case "text": {
        this.store.appendHistory(sessionId, { role: "agent", text: event.data, at: new Date().toISOString() });
        const s = this.store.update(sessionId, { status: "active" }) ?? this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.turn, { sessionId, kind: event.type });
        return s;
      }
      case "question": {
        const q: PlanningQuestion = event.data;
        this.store.appendHistory(sessionId, {
          role: "agent",
          text: JSON.stringify({ question: q }),
          at: new Date().toISOString(),
        });
        const s = this.store.update(sessionId, { status: "awaiting_input", currentQuestion: q }) ?? this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.question, { sessionId, questionId: q.id });
        return s;
      }
      case "complete": {
        const artifactPath = this.writeArtifact(sessionId, event.data);
        this.store.appendHistory(sessionId, {
          role: "agent",
          text: JSON.stringify({ complete: true }),
          at: new Date().toISOString(),
        });
        const s =
          this.store.update(sessionId, { status: "completed", currentQuestion: null, artifactPath }) ??
          this.requireSession(sessionId);
        this.ctx.emitEvent(CE_EVENTS.completed, { sessionId, artifactPath });
        return s;
      }
      case "error": {
        const message = event.data.message;
        // Error preserves progress (currentQuestion/history untouched) so retry
        // can resume. Status error; observable event emitted.
        const s = this.store.update(sessionId, { status: "error", error: message }) ?? this.requireSession(sessionId);
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
    this.pipelineStore.upsertState({
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
  private interruptSession(sessionId: string, cause: unknown): CeSession {
    const message = cause instanceof Error ? cause.message : String(cause);
    const s =
      this.store.update(sessionId, { status: "interrupted", error: message }) ?? this.requireSession(sessionId);
    this.ctx.emitEvent(CE_EVENTS.interrupted, { sessionId, message });
    return s;
  }

  /** Persist `error` (session-create failure path) and emit. */
  private failSession(sessionId: string, cause: unknown): CeSession {
    const message = cause instanceof Error ? cause.message : String(cause);
    const s = this.store.update(sessionId, { status: "error", error: message }) ?? this.requireSession(sessionId);
    this.ctx.emitEvent(CE_EVENTS.error, { sessionId, message });
    return s;
  }

  /**
   * Write the stage artifact to its conventional location (R10). Accepts either
   * a `{ artifact: string }` payload or a raw string. Returns the absolute path.
   */
  private writeArtifact(sessionId: string, data: unknown): string {
    const session = this.requireSession(sessionId);
    const stage = getStage(session.stage);
    const location = stage?.artifactLocation ?? `docs/ce/${session.stage}/`;
    const content = this.extractArtifactContent(data);

    const target = location.endsWith("/")
      ? join(location, `${session.stage}-${session.id}.md`)
      : location;
    const abs = isAbsolute(target) ? target : join(this.projectRoot, target);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
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

  private requireSession(sessionId: string): CeSession {
    const s = this.store.get(sessionId);
    if (!s) throw new Error(`CE session not found: ${sessionId}`);
    return s;
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
  }
}
