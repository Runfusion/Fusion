import type { AutoRecoveryFailureClass, AutoRecoveryMode, AutoRecoverySettings, Task, TaskStore } from "@fusion/core";
import { createLogger, type Logger } from "./logger.js";
import type { RunAuditor } from "./run-audit.js";

export type AutoRecoveryAction = "retry" | "spawn-ai-recovery" | "pause";

export interface AutoRecoveryFailure {
  class: AutoRecoveryFailureClass;
  taskId: string;
  runId?: string;
  pausedReason: string;
  evidence?: Record<string, unknown>;
  underlyingError?: Error;
}

export interface AutoRecoveryDecision {
  action: AutoRecoveryAction;
  rationale: string;
  auditMetadata: Record<string, unknown>;
  legacyPausedReason: string;
}

export interface AutoRecoveryContext {
  task: Task;
  retryCount: number;
  settings: AutoRecoverySettings;
  now?: () => Date;
}

export interface AutoRecoveryHandlers {
  issueRetry?: (failure: AutoRecoveryFailure, decision: AutoRecoveryDecision, ctx: AutoRecoveryContext) => Promise<void>;
  spawnAiRecovery?: (failure: AutoRecoveryFailure, decision: AutoRecoveryDecision, ctx: AutoRecoveryContext) => Promise<void>;
}

const autoRecoveryLog = createLogger("auto-recovery");

function actionForMode(mode: AutoRecoveryMode, failureClass: AutoRecoveryFailureClass): AutoRecoveryAction {
  if (mode === "off" || mode === "deterministic-only") return "pause";
  if (mode === "programmatic") {
    if (failureClass === "file-scope-invariant" || failureClass === "post-squash-audit-blocker") return "pause";
    return "retry";
  }
  if (mode === "ai-assisted") {
    if (failureClass === "file-scope-invariant" || failureClass === "post-squash-audit-blocker") return "spawn-ai-recovery";
    return "retry";
  }
  return "pause";
}

function isDestructiveAmbiguity(failure: AutoRecoveryFailure): boolean {
  if (failure.evidence?.destructiveAmbiguity === true) return true;
  const own = Number(failure.evidence?.ownCommits ?? 0);
  const foreign = Number(failure.evidence?.foreignAttributedCommits ?? 0);
  return own > 0 && foreign > 0;
}

export class AutoRecoveryDispatcher {
  private readonly taskStore: TaskStore;
  private readonly auditEmitter: RunAuditor;
  private readonly handlers: AutoRecoveryHandlers;
  private readonly logger: Logger;

  constructor(opts: { taskStore: TaskStore; auditEmitter: RunAuditor; handlers?: AutoRecoveryHandlers; logger?: Logger }) {
    this.taskStore = opts.taskStore;
    this.auditEmitter = opts.auditEmitter;
    this.handlers = opts.handlers ?? {};
    this.logger = opts.logger ?? autoRecoveryLog;
  }

  classify(failure: AutoRecoveryFailure, context: AutoRecoveryContext): AutoRecoveryDecision {
    if (context.settings.mode === "off") {
      return {
        action: "pause",
        rationale: "auto-recovery-disabled",
        legacyPausedReason: failure.pausedReason,
        auditMetadata: { class: failure.class, mode: "off", retryCount: context.retryCount, rationale: "auto-recovery-disabled" },
      };
    }

    const effectiveMode = context.settings.perClass?.[failure.class] ?? context.settings.mode;

    if (isDestructiveAmbiguity(failure)) {
      return {
        action: "pause",
        rationale: "destructive-ambiguity",
        legacyPausedReason: failure.pausedReason,
        auditMetadata: { class: failure.class, mode: effectiveMode, retryCount: context.retryCount, rationale: "destructive-ambiguity" },
      };
    }

    const maxRetries = context.settings.maxRetries ?? 3;
    if (context.retryCount >= maxRetries) {
      return {
        action: "pause",
        rationale: "retry-budget-exhausted",
        legacyPausedReason: failure.pausedReason,
        auditMetadata: { class: failure.class, mode: effectiveMode, retryCount: context.retryCount, rationale: "retry-budget-exhausted", maxRetries },
      };
    }

    const action = actionForMode(effectiveMode, failure.class);
    const rationale = `mode-${effectiveMode}`;
    return {
      action,
      rationale,
      legacyPausedReason: failure.pausedReason,
      auditMetadata: { class: failure.class, mode: effectiveMode, retryCount: context.retryCount, rationale },
    };
  }

  async dispatch(failure: AutoRecoveryFailure, context: AutoRecoveryContext): Promise<AutoRecoveryDecision> {
    void this.taskStore;
    const decision = this.classify(failure, context);
    await this.auditEmitter.database({
      type: "auto-recovery:classify-decision",
      target: failure.taskId,
      metadata: decision.auditMetadata,
    });

    if (decision.rationale === "destructive-ambiguity") {
      await this.auditEmitter.database({
        type: "auto-recovery:pause-because-destructive-ambiguity",
        target: failure.taskId,
        metadata: decision.auditMetadata,
      });
      return decision;
    }

    if (decision.action === "retry") {
      if (!this.handlers.issueRetry) {
        this.logger.warn(`auto-recovery: handler-not-registered for class=${failure.class} action=retry — falling back to pause`);
        return { ...decision, action: "pause", rationale: "handler-not-registered" };
      }
      await this.handlers.issueRetry(failure, decision, context);
      await this.auditEmitter.database({
        type: "auto-recovery:retry-issued",
        target: failure.taskId,
        metadata: decision.auditMetadata,
      });
      return decision;
    }

    if (decision.action === "spawn-ai-recovery") {
      if (!this.handlers.spawnAiRecovery) {
        this.logger.warn(`auto-recovery: handler-not-registered for class=${failure.class} action=spawn-ai-recovery — falling back to pause`);
        return { ...decision, action: "pause", rationale: "handler-not-registered" };
      }
      await this.handlers.spawnAiRecovery(failure, decision, context);
      await this.auditEmitter.database({
        type: "auto-recovery:ai-session-spawned",
        target: failure.taskId,
        metadata: decision.auditMetadata,
      });
      return decision;
    }

    return decision;
  }
}
