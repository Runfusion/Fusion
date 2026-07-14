/**
 * FNXC:PlannerOversight 2026-07-13-22:55:
 * Per-project session-advisor service: owns per-task emission guards,
 * advisor runtimes, and delivery through addSteeringComment + intervention
 * façade. Model gate: no runtime is started without a configured overseer
 * model (or an injected agent factory for tests). Human-control and
 * effective oversight level are re-checked at inject time.
 */

import {
  OverseerEmissionGuard,
  emitOverseerSteering,
  type OverseerAdviceSeverity,
  type PlannerOversightLevel,
  type Task,
  type Settings,
} from "@fusion/core";
import { createLogger } from "./logger.js";
import { evaluateOverseerHumanControl } from "./overseer-human-control-policy.js";
import {
  OverseerAdvisorRuntime,
  type OverseerAdvisorAgent,
  type OverseerAdvisorRuntimeHost,
} from "./overseer-advisor-runtime.js";
import {
  OVERSEER_ADVISOR_REPLY_CONTRACT,
  OverseerAdviseRecorder,
  parseAdvisorReplyForAdvice,
} from "./overseer-advise-tool.js";
import { discoverOverseerWatchdogFiles, formatOverseerWatchdogPromptBlocks } from "./overseer-watchdog.js";
import type { OverseerLogEntry } from "./overseer-session-delta.js";

const log = createLogger("overseer-advisor-service");

export interface OverseerAdvisorModelConfig {
  provider: string;
  modelId: string;
}

export interface OverseerAdvisorServiceStore {
  addSteeringComment(taskId: string, text: string, author: "agent" | "user"): Promise<unknown>;
  getTask?(taskId: string): Promise<Task | undefined>;
  getSettings?(): Promise<Settings | undefined>;
  recordRunAuditEvent?(input: unknown): unknown;
  getRunAuditEvents?(options?: unknown): unknown[];
  getAgentLogs?(taskId: string, opts?: { limit?: number }): Promise<OverseerLogEntry[]>;
}

export type OverseerAdvisorAgentFactory = (ctx: {
  taskId: string;
  model: OverseerAdvisorModelConfig;
  systemPrompt: string;
  onAdvice: (note: string, severity?: OverseerAdviceSeverity) => void | Promise<void>;
}) => Promise<OverseerAdvisorAgent | null>;

export interface OverseerAdvisorServiceOptions {
  store: OverseerAdvisorServiceStore;
  /** Resolve model for the overseer; return null to leave session AI soft-disabled. */
  resolveModel?: (task: Task) => OverseerAdvisorModelConfig | null | Promise<OverseerAdvisorModelConfig | null>;
  /** Resolve effective planner oversight level for a task. */
  resolveLevel: (task: Task) => PlannerOversightLevel | Promise<PlannerOversightLevel>;
  /** Optional worktree/cwd for WATCHDOG discovery. */
  resolveCwd?: (task: Task) => string | undefined;
  agentFactory?: OverseerAdvisorAgentFactory;
  settings?: Pick<Settings, "autoMerge">;
}

interface TaskAdvisorState {
  guard: OverseerEmissionGuard;
  runtime: OverseerAdvisorRuntime;
  advise: OverseerAdviseRecorder;
  level: PlannerOversightLevel;
  lastAdviceSeverity?: OverseerAdviceSeverity;
  backlog: number;
}

/**
 * Builds a simple agent that prompts an injectable `complete(system, user)`
 * function and parses the reply — used when no full pi session factory is wired.
 */
export function createParsingOverseerAgent(opts: {
  complete: (systemPrompt: string, userBatch: string) => Promise<string>;
  systemPrompt: string;
  onAdvice: (note: string, severity?: OverseerAdviceSeverity) => void | Promise<void>;
}): OverseerAdvisorAgent {
  const advise = new OverseerAdviseRecorder(opts.onAdvice);
  return {
    async prompt(input: string) {
      const reply = await opts.complete(opts.systemPrompt, input);
      const parsed = parseAdvisorReplyForAdvice(reply);
      if (parsed) {
        await advise.execute(parsed);
      }
    },
    reset() {
      advise.resetDeliveredNotes();
    },
  };
}

export class OverseerAdvisorService {
  private readonly store: OverseerAdvisorServiceStore;
  private readonly resolveModel?: OverseerAdvisorServiceOptions["resolveModel"];
  private readonly resolveLevel: OverseerAdvisorServiceOptions["resolveLevel"];
  private readonly resolveCwd?: OverseerAdvisorServiceOptions["resolveCwd"];
  private readonly agentFactory?: OverseerAdvisorAgentFactory;
  private settings: Pick<Settings, "autoMerge"> | undefined;
  private readonly tasks = new Map<string, TaskAdvisorState>();

  constructor(options: OverseerAdvisorServiceOptions) {
    this.store = options.store;
    this.resolveModel = options.resolveModel;
    this.resolveLevel = options.resolveLevel;
    this.resolveCwd = options.resolveCwd;
    this.agentFactory = options.agentFactory;
    this.settings = options.settings;
  }

  setSettings(settings: Pick<Settings, "autoMerge"> | undefined): void {
    this.settings = settings;
  }

  /** Snapshot fields for PlannerOverseerRuntimeSnapshot enrichment. */
  getTaskAdvisorSnapshot(taskId: string): {
    backlog?: number;
    lastAdviceSeverity?: OverseerAdviceSeverity;
    active: boolean;
  } {
    const state = this.tasks.get(taskId);
    if (!state) return { active: false };
    return {
      active: true,
      backlog: state.runtime.backlog,
      lastAdviceSeverity: state.lastAdviceSeverity,
    };
  }

  async ensureTask(task: Task): Promise<boolean> {
    try {
      if (this.tasks.has(task.id)) return true;

      const level = await this.resolveLevel(task);
      if (level === "off") return false;

      const model = this.resolveModel ? await this.resolveModel(task) : null;
      if (!model && !this.agentFactory) {
        // Soft-disable: no model configured (A1).
        return false;
      }

      const human = evaluateOverseerHumanControl(task, this.settings);
      if (human.withhold) return false;

      const guard = new OverseerEmissionGuard();
      /*
      FNXC:PlannerOversight 2026-07-14-00:10:
      Greptile P1: do NOT capture level into the advise callback closure.
      deliverAdvice re-resolves effective oversight level at inject time so an
      operator flip to observe/off mid-session cannot keep injecting.
      */
      const advise = new OverseerAdviseRecorder(async (note, severity) => {
        await this.deliverAdvice(task.id, note, severity);
      });

      const cwd = this.resolveCwd?.(task);
      const watchdogBlocks =
        cwd != null
          ? formatOverseerWatchdogPromptBlocks(discoverOverseerWatchdogFiles({ cwd }))
          : [];
      const systemPrompt = [OVERSEER_ADVISOR_REPLY_CONTRACT, ...watchdogBlocks].join("\n\n");

      const onAdvice = async (note: string, severity?: OverseerAdviceSeverity) => {
        await advise.execute({ note, severity });
      };

      let agent: OverseerAdvisorAgent | null = null;
      if (this.agentFactory && model) {
        agent = await this.agentFactory({
          taskId: task.id,
          model,
          systemPrompt,
          onAdvice,
        });
      } else if (this.agentFactory) {
        agent = await this.agentFactory({
          taskId: task.id,
          model: model ?? { provider: "mock", modelId: "scripted" },
          systemPrompt,
          onAdvice,
        });
      }

      if (!agent) return false;

      const host: OverseerAdvisorRuntimeHost = {
        beginAdvisorUpdate: () => guard.beginUpdate(),
        enqueueAdvice: async (note, severity) => {
          // Runtime path when agent calls host directly; prefer advise recorder.
          await advise.execute({ note, severity });
        },
        notifyFailure: (err) => {
          log.warn(`session advisor failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        },
      };

      const runtime = new OverseerAdvisorRuntime({ agent, host });
      // Seed to "now" so enabling mid-task does not replay full history.
      // Host may immediately push a snapshot afterward if desired.
      runtime.seedTo(0);

      this.tasks.set(task.id, {
        guard,
        runtime,
        advise,
        level,
        backlog: 0,
      });
      return true;
    } catch (err) {
      log.warn(`ensureTask failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Feed new executor log entries into the task's advisor runtime.
   * Creates the runtime on demand when `task` is provided.
   */
  async onExecutorLogDelta(
    taskId: string,
    entries: ReadonlyArray<OverseerLogEntry>,
    task?: Task,
  ): Promise<void> {
    try {
      let state = this.tasks.get(taskId);
      if (!state && task) {
        const ok = await this.ensureTask(task);
        if (!ok) return;
        state = this.tasks.get(taskId);
      }
      if (!state || entries.length === 0) return;
      state.runtime.onLogDelta(entries);
    } catch (err) {
      log.warn(`onExecutorLogDelta failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  clear(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    state.runtime.dispose();
    this.tasks.delete(taskId);
  }

  clearAll(): void {
    for (const id of [...this.tasks.keys()]) {
      this.clear(id);
    }
  }

  /**
   * Test/helper: run emission guard against a note without a full runtime.
   */
  acceptNoteForTest(taskId: string, note: string, severity?: OverseerAdviceSeverity): boolean {
    const state = this.tasks.get(taskId);
    if (!state) return false;
    state.guard.beginUpdate();
    return state.guard.accept({ note, severity });
  }

  /**
   * FNXC:PlannerOversight 2026-07-14-00:10:
   * Inject-time policy: re-resolve oversight level + human-control from the
   * live task/settings so mid-session flips (level→observe/off, autoMerge:false)
   * cannot be bypassed by a level captured at ensureTask time.
   */
  private async deliverAdvice(
    taskId: string,
    note: string,
    severity: OverseerAdviceSeverity | undefined,
  ): Promise<void> {
    try {
      const state = this.tasks.get(taskId);
      if (!state) return;

      // Emission guard — load-bearing silence/dedupe.
      if (!state.guard.accept({ note, severity })) {
        return;
      }

      const task = this.store.getTask ? await this.store.getTask(taskId) : undefined;
      if (!task) {
        // Cannot verify level/human-control without a task — refuse inject.
        return;
      }

      const human = evaluateOverseerHumanControl(task, this.settings);
      if (human.withhold) return;

      const level = await this.resolveLevel(task);
      state.level = level;

      if (level === "off") {
        // Tear down so we stop spending model turns until re-enabled.
        this.clear(taskId);
        return;
      }

      // observe: record timeline only when store supports audit; no inject.
      if (level === "observe") {
        this.emitSteeringSafe(taskId, note, severity, "pending");
        state.lastAdviceSeverity = severity;
        return;
      }

      if (level !== "steer" && level !== "autonomous") {
        return;
      }

      const severityAttr = severity ? ` severity="${severity}"` : "";
      const text = `[session-advisor]${severityAttr} ${note}`;
      await this.store.addSteeringComment(taskId, text, "agent");
      this.emitSteeringSafe(taskId, note, severity, "pending");
      state.lastAdviceSeverity = severity;
    } catch (err) {
      log.warn(`deliverAdvice failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private emitSteeringSafe(
    taskId: string,
    reason: string,
    severity: OverseerAdviceSeverity | undefined,
    outcome: "pending" | "succeeded",
  ): void {
    if (!this.store.recordRunAuditEvent || !this.store.getRunAuditEvents) return;
    try {
      emitOverseerSteering({
        store: this.store as Parameters<typeof emitOverseerSteering>[0]["store"],
        taskId,
        stage: "executor",
        reason,
        outcome,
        severity,
        source: "session-advisor",
      });
    } catch (err) {
      log.warn(`emitOverseerSteering failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
