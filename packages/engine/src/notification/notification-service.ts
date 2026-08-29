import type {
  ChatRoomMessage,
  Column,
  MergeResult,
  Message,
  MessageCreateInput,
  NotificationEvent,
  NotificationPayload,
  NotificationProvider,
  Settings,
  Task,
} from "@fusion/core";
import type { LifecycleColumns, TaskMoveLanes, WorkflowIrResolverStore } from "@fusion/core";
import { DASHBOARD_USER_ID, isTaskNotFoundError, MAX_TERMINAL_FAILURE_AUTO_RETRIES, NotificationDispatcher, resolveProjectColumnsForRoles, resolveReviewColumns, resolveTaskLifecycleColumns, resolveWorkflowIrForTask, WEDGE_RENOTIFY_COOLDOWN_MS } from "@fusion/core";
import { DEFAULT_NTFY_EVENTS, buildNtfyClickUrl, formatTaskIdentifier } from "../util/notifier.js";
import { schedulerLog } from "../logger.js";
import { NtfyNotificationProvider } from "./ntfy-provider.js";
import { WebhookNotificationProvider } from "./webhook-provider.js";
import { classifyTerminalFailureAutoRecoveryForTask, describeTaskRecoveryOwner, describeTaskWedge, isTaskProgressing, shouldWithholdWedgeAlertForAutoRecovery, type TaskWedgeDescriptor } from "./task-wedge-notification.js";

type PendingWedgeCompletionOutcome = "delivered" | "suppressed" | "cleared" | "rearmed" | "held" | "absent" | "unreadable";
type PendingWedgeCompletionResult = { outcome: PendingWedgeCompletionOutcome; reasonKey?: string; remainingMs?: number };

export interface NotificationServiceOptions {
  /** Project identifier for notification deep links */
  projectId?: string;
  /** Base URL for ntfy.sh (backward compat with NtfyNotifierOptions) */
  ntfyBaseUrl?: string;
  /** Optional message store for mailbox message notifications */
  messageStore?: NotificationMessageStore;
  /** Optional chat store for room message notifications */
  chatStore?: NotificationChatStore;
  /** Resolve human-readable name for an agent ID used in message notifications */
  agentNameResolver?: (agentId: string) => Promise<string | null> | string | null;
  /** Test hook to override failed-notification grace period (default 60_000ms). */
  failedNotificationGraceMs?: number;
  /** Test hook for the durable terminal-wedge settle window. */
  wedgeNotificationSettleMs?: number;
}

interface NotificationServiceStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: Column; to: Column }];
  "task:updated": [task: Task, meta?: { lanes?: TaskMoveLanes }];
  "task:merged": [result: MergeResult];
  "settings:updated": [payload: { settings: Settings; previous: Settings }];
}

interface NotificationServiceStore {
  getSettings(): Promise<Settings> | Settings;
  getTask?(id: string): Promise<Task | undefined> | Task | undefined;
  /** Durable compare-and-set for restart-safe wedge delivery episodes. */
  claimTaskWedgeNotificationEpisode?(taskId: string, reasonKey: string | null): Promise<{ episodeId?: string; claimed: boolean }>;
  markTaskWedgeNotificationPending?(taskId: string, descriptor: { reasonKey: string; source: "auto" | "supplied"; reason: string; action: string; gate?: string }, options?: { staleAfterMs?: number }): Promise<{ since: string; armed: boolean; restamped: boolean }>;
  clearTaskWedgeNotificationPending?(taskId: string, reasonKey?: string): Promise<boolean>;
  /** Optional so lightweight notification fakes retain their structural surface. */
  markTerminalFailureAutoRecoveryBudgetExhausted?(taskId: string, options: { maxAttempts: number }): Promise<"stamped" | "already-stamped" | "not-exhausted" | "no-budget">;
  /** Optional; self-healing's concrete store is the durable backstop when absent. */
  markTerminalFailureAutoRecoveryEscalationDelivered?(taskId: string, input: { dispatchOutcome: "delivered" | "suppressed"; escalationReason: "budget-exhausted" | "auto-recovery-disabled" }): Promise<"stamped" | "already-stamped" | "not-stamped-stale-suppression" | "no-budget">;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (fleet phase — notification lifecycle guards):
  The workflow-IR resolver surface, OPTIONAL. The real `TaskStore` implements all three; declaring them
  optional is what keeps this a structural interface, so the light test fakes that supply only
  `getSettings`/`on`/`off` still satisfy it.

  When they are absent, `resolveTaskLifecycleColumns` catches and returns undefined and every guard
  below falls back to its legacy id — the same fail-soft the resolver documents. Requiring them here
  would instead have forced a workflow surface into every notification fake.
  */
  getTaskWorkflowSelection?: WorkflowIrResolverStore["getTaskWorkflowSelection"];
  getTaskWorkflowSelectionAsync?: WorkflowIrResolverStore["getTaskWorkflowSelectionAsync"];
  getWorkflowDefinition?: WorkflowIrResolverStore["getWorkflowDefinition"];
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-21:20:
  The PROJECT-level read `resolveProjectColumnsForRoles` needs. Optional for the same reason as the
  three above — an absent method degrades to the legacy ids rather than forcing a workflow surface
  into every notification fake — and, unlike the sync selection readers, this one is answerable under
  PostgreSQL, which is what makes the lane answers here real rather than decorative.
  */
  listWorkflowDefinitions?: () => Promise<ReadonlyArray<{ ir?: unknown }>>;
  on<K extends keyof NotificationServiceStoreEvents>(
    event: K,
    listener: (...args: NotificationServiceStoreEvents[K]) => void,
  ): void;
  on(event: string | symbol, listener: (...args: any[]) => void): void;
  off<K extends keyof NotificationServiceStoreEvents>(
    event: K,
    listener: (...args: NotificationServiceStoreEvents[K]) => void,
  ): void;
  off(event: string | symbol, listener: (...args: any[]) => void): void;
}

interface NotificationMessageStore {
  on(event: "message:sent", listener: (message: Message) => void): void;
  off?(event: "message:sent", listener: (message: Message) => void): void;
  /*
  FNXC:PlanApprovalMailbox 2026-07-16-19:20:
  The awaiting-approval mailbox message is written via sendMessageOnce so replans that
  re-enter awaiting-approval reuse the deterministic id and do not spam the operator inbox.
  Optional so test/light message-store fakes without a write side still satisfy the type.
  */
  sendMessageOnce?(
    input: MessageCreateInput,
    idempotencyKey: string,
  ): Promise<{ message: Message; inserted: boolean }>;
}

export interface NotificationChatStore {
  on(event: "chat:room:message:added", listener: (message: ChatRoomMessage) => void): void;
  off?(event: "chat:room:message:added", listener: (message: ChatRoomMessage) => void): void;
  getRoom?(id: string): Promise<{ id: string; name: string } | undefined> | { id: string; name: string } | undefined;
}

export class NotificationService {
  private readonly dispatcher = new NotificationDispatcher();
  private readonly notifiedEvents = new Set<string>();
  private started = false;
  private chatStore: NotificationChatStore | undefined;
  private notificationsEnabled = false;
  /*
  FNXC:PlanApprovalMailbox 2026-07-16-19:20:
  Cache the dashboard host from settings.ntfyDashboardHost so the synchronous task:updated
  handler can build a task deep-link for the awaiting-approval mailbox message without an
  async settings read. Undefined when the operator has not configured a dashboard host; the
  mailbox message then falls back to the task identifier without an absolute URL.
  */
  private dashboardHost?: string;
  private ntfyProvider?: NtfyNotificationProvider;
  private webhookProvider?: WebhookNotificationProvider;
  private refreshInFlight: Promise<void> | null = null;
  private readonly pendingFailureNotifications = new Map<string, { timer: NodeJS.Timeout; payload: NotificationPayload }>();
  private readonly pendingFailureStartTimes = new Map<string, number>();
  private readonly failedNotificationGraceMs: number;
  private failureNotificationSuppressedCount = 0;
  private failureNotificationDelayMs = 60_000;
  private failureNotificationMode: "sticky-only" | "all" | "terminal-only" = "sticky-only";
  private wedgeNotificationSettleMs = 300_000;
  private maintenanceIntervalMs = 900_000;
  private wedgeNotificationSuppressedCount = 0;
  private readonly pendingWedgeNotifications = new Map<string, { timer?: NodeJS.Timeout; descriptor: TaskWedgeDescriptor; source: "auto" | "supplied"; since: string; task: Task }>();
  /** Compatibility fallback for lightweight test stores without the durable TaskStore CAS. */
  private readonly activeWedgeReasons = new Map<string, string>();
  /*
  FNXC:TaskWedgeNotifications 2026-08-01-15:35:
  Lightweight stores lack the durable compare-and-set, but must retain the same
  per-task, per-reason cooldown. Clearing an active episode deliberately does not
  clear these timestamps: X -> Y -> X must not re-notify X inside its window.
  */
  private readonly fallbackWedgeNotificationTimestamps = new Map<string, Map<string, number>>();
  /*
  FNXC:TaskWedgeNotifications 2026-07-31-21:10:
  PER-TASK SERIALISATION OF WEDGE HANDLING — the blocker two earlier fleet passes recorded and
  declined to take on.

  `handleTaskUpdated` is a synchronous `(task) => void` listener that starts `maybeNotifyTaskWedge`
  fire-and-forget, and one branch of that method RESOLVES an episode while another CLAIMS one. With
  no ordering between them, any await added before the resolve lets a re-wedge arriving close behind
  reach `claim` while the previous episode is still `active`; the claim returns `claimed: false` and
  the second operator notification is silently dropped. That is measured, not theoretical: it is what
  `task-wedge-notification.test.ts > "sends one actionable push and mailbox message per active
  terminal episode"` catches, and it is why the column conversion in this file was reverted twice.

  A per-task promise chain fixes the ordering itself rather than the symptom. Handling for one task
  runs to completion before the next handling for that task begins, so resolve-then-claim keeps its
  order no matter how many awaits either branch acquires. Different tasks stay concurrent — the chain
  is keyed by task id, not global.

  The entry is deleted when the chain drains, so this map does not grow with the task table. Chain
  links never reject: `maybeNotifyTaskWedge` already owns its own error handling, and a rejected link
  would poison every later notification for that task.
  */
  private readonly wedgeHandlingChains = new Map<string, Promise<void>>();

  /**
   * Queues wedge handling for one task behind any handling already in flight for it.
   *
   * FNXC:TaskWedgeNotifications 2026-08-11-19:20:
   * This queue deliberately resolves only to void and never rejects. Timer and sweep callers use
   * the public completion wrapper's closure-captured outcome; an in-chain observation calls the
   * queue-free core directly. Re-entering this queue from a link would wait on its own successor
   * and permanently deadlock all later wedge handling for that task.
   */
  private enqueueWedgeHandling(taskId: string, run: () => Promise<void>): Promise<void> {
    const previous = this.wedgeHandlingChains.get(taskId) ?? Promise.resolve();
    const execute = async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        schedulerLog.debug(`[notify] ${taskId} wedge handling failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const next = previous.then(execute, execute);
    this.wedgeHandlingChains.set(taskId, next);
    void next.finally(() => {
      if (this.wedgeHandlingChains.get(taskId) === next) this.wedgeHandlingChains.delete(taskId);
    });
    return next;
  }

  constructor(
    private readonly store: NotificationServiceStore,
    private readonly options: NotificationServiceOptions = {},
  ) {
    this.chatStore = options.chatStore;
    this.failedNotificationGraceMs = options.failedNotificationGraceMs ?? 60_000;
    this.failureNotificationDelayMs = this.failedNotificationGraceMs;
    this.wedgeNotificationSettleMs = options.wedgeNotificationSettleMs ?? 300_000;
  }

  attachChatStore(chatStore: NotificationChatStore): void {
    if (this.chatStore && this.chatStore !== chatStore) {
      this.detachChatStoreListener(this.chatStore);
    }
    this.chatStore = chatStore;
    if (this.started) {
      this.chatStore.on("chat:room:message:added", this.handleRoomMessageAdded);
    }
  }

  registerProvider(provider: NotificationProvider): void {
    this.dispatcher.registerProvider(provider);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const settings = await this.store.getSettings();
    this.setNotificationsEnabledFromSettings(settings);
    this.dashboardHost = settings.ntfyDashboardHost;
    this.refreshFailureNotificationSettings(settings);
    await this.syncNtfyProvider(settings);
    await this.syncWebhookProvider(settings);

    await this.dispatcher.initializeAll();

    this.store.on("task:created", this.handleTaskCreated);
    this.store.on("task:moved", this.handleTaskMoved);
    this.store.on("task:updated", this.handleTaskUpdated);
    this.store.on("task:merged", this.handleTaskMerged);
    this.store.on("settings:updated", this.handleSettingsUpdated);
    this.options.messageStore?.on("message:sent", this.handleMessageSent);
    this.started = true;
    this.chatStore?.on("chat:room:message:added", this.handleRoomMessageAdded);
    schedulerLog.debug("NotificationService started");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (typeof this.store.off === "function") {
      this.store.off("task:created", this.handleTaskCreated);
      this.store.off("task:moved", this.handleTaskMoved);
      this.store.off("task:updated", this.handleTaskUpdated);
      this.store.off("task:merged", this.handleTaskMerged);
      this.store.off("settings:updated", this.handleSettingsUpdated);
      if (typeof this.options.messageStore?.off === "function") {
        this.options.messageStore.off("message:sent", this.handleMessageSent);
      }
      this.detachChatStoreListener(this.chatStore);
    }

    for (const pending of this.pendingFailureNotifications.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingFailureNotifications.clear();
    this.pendingFailureStartTimes.clear();
    for (const pending of this.pendingWedgeNotifications.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pendingWedgeNotifications.clear();

    await this.dispatcher.shutdownAll();
    this.started = false;

    schedulerLog.debug("NotificationService stopped");
  }

  private handleTaskCreated = (task: Task): void => {
    void this.handleTaskCreatedAsync(task);
  };

  private async handleTaskCreatedAsync(task: Task): Promise<void> {
    if (typeof task.sourceAgentId !== "string" || task.sourceAgentId.trim().length === 0) {
      return;
    }

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("task:created");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    const sourceAgentId = task.sourceAgentId.trim();
    const agentName = await this.resolveAgentName("agent", sourceAgentId, "from");

    this.maybeNotify(task.id, "task-created", {
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      event: "task-created",
      metadata: {
        sourceAgentId,
        ...(agentName ? { agentName } : {}),
        sourceType: task.sourceType,
      },
    });
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (fleet phase):
  ONE place this service asks "which column plays which lifecycle role for this task".

  NO SERVICE-LIFETIME CACHE, deliberately. `resolveTaskLifecycleColumns` takes a caller-owned IR cache
  and a long-lived one here would be tempting — this runs per task move. But the service has no
  workflow-definition-changed event to invalidate on, so a cached IR would outlive an operator's
  workflow edit and keep notifying against the old column vocabulary. A stale answer is worse than the
  read: the caller-owned cache is documented for a bounded SWEEP, which this is not.

  Each call site below is therefore placed AFTER whatever cheap gate it already had, so a task move that
  cannot produce a notification does not pay for a resolution.
  */
  private async resolveLifecycleColumnsForTask(taskId: string): Promise<LifecycleColumns | undefined> {
    return resolveTaskLifecycleColumns(this.store as WorkflowIrResolverStore, taskId);
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-03:20 (PR #2722 review — greptile):
  REVIEW IS A SET, AND `humanReview` COUNTS. `resolveLifecycleColumns().review` reads the
  `mergeOrchestration` flag only, so a lane carrying the `human-review` trait and NOT the merge trait
  resolves to nothing — the guard fell back to the literal `in-review`, and on a renamed board the
  operator's "ready for review" notification simply never fired. Silent: no error, no log, the card
  just arrives unannounced.

  Same union the dashboard routes already use (`resolveReviewColumnsForTask`), so this is that
  established idiom applied here rather than a new notion of "review". Membership, not equality: a
  workflow may declare more than one review lane, and asking "is this card ALREADY there" is a set
  question — the arity rule #2713 wrote down after fixing it twice.
  */
  private async resolveReviewColumnsForTask(taskId: string): Promise<Set<string>> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-16:40 (PR #2722 review — greptile, the MIRROR of the bug
      this method was added to fix):
      I built this union from `mergeBlocker` + `humanReview` and left `mergeOrchestration` OUT — so a
      renamed review lane carrying only the merge trait was excluded, and moving a task there skipped
      the operator's review notification. That is the same silent miss I added this method to fix,
      pointed the other way.

      `resolveReviewColumns` (core, #2730) is the shared answer to exactly this question and covers all
      three flags. The BROAD set is right here — a notification is emitted, nothing is moved, so
      over-admission costs an extra notification and under-admission costs the operator their signal.
      #2750 documents the split for callers that move.
      */
      const ir = await resolveWorkflowIrForTask(this.store as WorkflowIrResolverStore, taskId);
      const lanes = resolveReviewColumns(ir);
      return lanes.length > 0 ? new Set(lanes) : new Set(["in-review"]);
    } catch {
      return new Set(["in-review"]);
    }
  }

  private handleTaskMoved = (data: { task: Task; from: Column; to: Column }): void => {
    void this.handleTaskMovedAsync(data);
  };

  private async handleTaskMovedAsync(data: { task: Task; from: Column; to: Column }): Promise<void> {
    await this.maybeSuppressTransientFailedNotification(data.task, `moved to ${data.to}`);

    /*
    FNXC:TaskWedgeNotifications 2026-08-11-18:57:
    task:moved is a production recovery path that does not enter maybeNotifyTaskWedge. A pending
    durable hold must be cleared when its subject visibly progresses, including workflow-renamed
    hold/WIP/terminal lanes, so its timer or restart sweep cannot alert after that recovery.
    */
    const movedProgressedLanes = await resolveProjectColumnsForRoles(this.store, ["hold", "countsTowardWip", "complete", "archived"]);
    if (
      movedProgressedLanes.has(data.to)
      || (typeof data.task.status === "string" && data.task.status !== "failed")
    ) {
      await this.clearPendingWedgeNotification(data.task.id);
    }

    const movedLifecycle = await this.resolveLifecycleColumnsForTask(data.task.id);

    if ((await this.resolveReviewColumnsForTask(data.task.id)).has(data.to)) {
      if (!this.notificationsEnabled) {
        await this.refreshNotificationState("task:moved");
        if (!this.notificationsEnabled) {
          return;
        }
      }

      const payload = this.createTaskPayload(data.task, "in-review");
      this.maybeNotify(data.task.id, "in-review", payload);
      return;
    }

    if (data.to === (movedLifecycle?.complete ?? "done") && this.isMergeBackedTerminalTask(data.task)) {
      // `task:merged` remains the canonical terminal merge event. This fallback
      // preserves notification parity for PR/webhook/recovery paths that reach
      // done through moveTask before (or without) a matching task:merged emit;
      // maybeNotify uses the same `merged` key so a later task:merged event is
      // suppressed instead of producing a duplicate alarm.
      if (!this.notificationsEnabled) {
        await this.refreshNotificationState("task:moved:done");
        if (!this.notificationsEnabled) {
          return;
        }
      }

      this.maybeNotify(data.task.id, "merged", this.createTaskPayload(data.task, "merged"));
    }
  };

  private autoRecoveryEnabled = true;

  private handleTaskUpdated = (task: Task, meta?: { lanes?: TaskMoveLanes }): void => {
    /*
    FNXC:TaskWedgeNotifications 2026-08-09-06:30:
    An update is a snapshot and resume paths can leave a pause marker behind.
    Use snapshot classification only for generic-failure scheduling; wedge delivery
    reclassifies the live row immediately before its episode claim.
    */
    const recoveryOwner = task.status === "failed" ? describeTaskRecoveryOwner(task) : null;
    const wedge = describeTaskWedge(task);
    const autoRecoveryWithheld = wedge != null && shouldWithholdWedgeAlertForAutoRecovery(task, { autoRecoveryEnabled: this.autoRecoveryEnabled });
    /*
    FNXC:TaskWedgeNotifications 2026-07-22-14:30:
    A generic failed push may have been scheduled before a terminal error was
    classified. Cancel it at wedge entry so the immediate episode alert is the
    only operator notification; dispatch-time suppression below covers races.
    */
    if (wedge) this.cancelPendingFailureNotification(task.id, "classified-terminal-wedge");
    void this.enqueueWedgeHandling(task.id, async () => { await this.maybeNotifyTaskWedge(task); });
    void this.maybeSuppressTransientFailedNotification(task, `status=${task.status ?? "undefined"}`);

    /*
    FNXC:PlanApprovalMailbox 2026-07-16-19:40:
    Write the durable awaiting-approval mailbox message BEFORE the push-enabled gate. The ntfy/webhook
    push respects `notificationsEnabled` (which requires ntfy or a webhook to be configured), but the
    mailbox message is an in-app channel that needs no push provider. Firing it here means a
    dashboard-only operator (no ntfy/webhook) still gets the durable, in-dashboard approval record —
    the whole point of the mailbox channel. Written as a `system` message (not `agent-to-user`) so it
    does NOT re-trigger the `message:agent-to-user` ntfy pipeline.
    */
    if (task.status === "awaiting-approval") {
      void this.writeAwaitingApprovalMailboxMessage(task);
    }

    if (this.isTriageDuplicateDecision(task)) {
      void this.writeTriageDuplicateDecisionMailboxMessage(task);
    }

    if (!this.notificationsEnabled) {
      return;
    }

    if (task.status === "failed" && (recoveryOwner || autoRecoveryWithheld)) {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.debug(`[notify] ${task.id} recovery-owned failure — suppressed notification`);
    } else if (task.status === "failed" && !wedge) {
      if (this.failureNotificationMode === "all") {
        void this.maybeNotifyImmediateFailure(task);
      } else {
        this.scheduleFailureNotification(task);
      }
    }

    if (task.status === "awaiting-approval") {
      /*
      FNXC:PlanReviewReplan 2026-07-15-11:09:
      Include awaitingApprovalReason so ntfy/webhook copy can tell operators why approval is
      required — especially plan-review-replan-cap (Plan Review exhausted automatic REVISE
      replans) vs a routine require-all / workflow manual plan gate.
      */
      this.maybeNotify(
        task.id,
        "awaiting-approval",
        this.createTaskPayload(task, "awaiting-approval", {
          awaitingApprovalReason: task.awaitingApprovalReason ?? "manual",
        }),
      );
      // FNXC:PlanApprovalMailbox 2026-07-16-19:40: the durable mailbox message is written
      // unconditionally at the top of handleTaskUpdated (decoupled from `notificationsEnabled`);
      // only the ntfy push above stays gated on push configuration.
    }

    if (task.status === "awaiting-user-review") {
      this.maybeNotify(
        task.id,
        "awaiting-user-review",
        this.createTaskPayload(task, "awaiting-user-review"),
      );
    }

    const workflowTransition = this.classifyWorkflowTransitionNotification(task, meta?.lanes?.review);
    if (workflowTransition) {
      this.maybeNotify(
        task.id,
        workflowTransition.event,
        this.createTaskPayload(task, workflowTransition.event, workflowTransition.metadata),
      );
    }
  };

  /*
  FNXC:PlanApprovalMailbox 2026-07-16-19:20:
  Durable in-dashboard record that a task's plan needs manual approval, linking to the task.
  - Fires from the same awaiting-approval transition as the ntfy push, covering both entry
    points (workflow manual plan gate and the Plan Review replan-cap escalation).
  - `sendMessageOnce` keyed by task id makes it idempotent: replanning that re-enters
    awaiting-approval, or NotificationService restarts, do not produce duplicate inbox rows.
  - Best-effort/fire-and-forget: a message-store write failure must never break the ntfy path
    or the task:updated handler, so errors are swallowed with a log line only.
  */
  private async writeAwaitingApprovalMailboxMessage(task: Task): Promise<void> {
    /*
    FNXC:PlanApprovalMailbox 2026-07-16-20:10:
    Called fire-and-forget (`void this.writeAwaitingApprovalMailboxMessage(task)`), so the ENTIRE
    body — not just the store write — must be inside try/catch. A throw in payload construction
    (e.g. formatTaskIdentifier on a malformed runtime task) would otherwise become an unhandled
    promise rejection that can crash the process. Best-effort: log and swallow.
    */
    try {
      const messageStore = this.options.messageStore;
      if (!messageStore?.sendMessageOnce) {
        return;
      }
      const identifier = formatTaskIdentifier(task);
      const reason = task.awaitingApprovalReason ?? "manual";
      /*
      FNXC:PullRequestMerge 2026-08-09-05:07:
      A policy-blocked PR uses the durable awaiting-approval mailbox transport,
      but it is not a plan gate. Keep its operator instruction explicit and use a
      distinct once-key so an earlier plan-approval notice cannot hide the block.
      */
      const isMergePolicyBlock = reason === "merge-blocked-by-policy";
      const reasonLine =
        reason === "plan-review-replan-cap"
          ? "Plan Review exhausted its automatic revision attempts and escalated this plan for a human decision."
          : isMergePolicyBlock
            ? "The pull request is blocked by repository policy. Resolve the policy requirement, then retry the merge."
            : "The generated plan is ready and needs your approval before execution begins.";
      const link = buildNtfyClickUrl({
        dashboardHost: this.dashboardHost,
        projectId: this.options.projectId,
        taskId: task.id,
      });
      const content = [
        isMergePolicyBlock ? `**${identifier} pull-request merge is blocked**` : `**${identifier} needs plan approval**`,
        "",
        reasonLine,
        ...(link ? ["", `[Open ${task.id}](${link})`] : []),
      ].join("\n");
      const input: MessageCreateInput = {
        fromId: "system",
        fromType: "system",
        toId: DASHBOARD_USER_ID,
        toType: "user",
        type: "system",
        content,
        metadata: { taskId: task.id, awaitingApprovalReason: reason },
      };
      await messageStore.sendMessageOnce(input, `${isMergePolicyBlock ? "merge-policy-block" : "plan-approval"}:${task.id}`);
    } catch (error) {
      schedulerLog.log(
        `[notify] ${task.id} awaiting-approval mailbox message failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /*
  FNXC:TaskWedgeNotifications 2026-07-22-12:00:
  Terminal task updates are the shared seam for merger, executor, heartbeat, and
  self-healing parks. Clear only on a non-wedge lifecycle update, allowing a
  resolved-then-reparked reason to begin a new actionable episode.
  */
  /** Delivers a self-healing no-action escalation through the durable wedge episode seam. */
  async notifyTaskWedge(
    task: Task,
    descriptor: TaskWedgeDescriptor,
    options?: { source?: "auto-recovery-escalation" },
  ): Promise<"delivered" | "suppressed" | "unavailable"> {
    let result: "delivered" | "suppressed" | "unavailable" = "unavailable";
    await this.enqueueWedgeHandling(task.id, async () => { result = await this.maybeNotifyTaskWedge(task, descriptor, options); });
    return result;
  }

  private async maybeNotifyTaskWedge(
    task: Task,
    suppliedDescriptor?: TaskWedgeDescriptor | null,
    options?: { source?: "auto-recovery-escalation" },
  ): Promise<"delivered" | "suppressed" | "unavailable"> {
    if (options?.source !== "auto-recovery-escalation" && shouldWithholdWedgeAlertForAutoRecovery(task, { autoRecoveryEnabled: this.autoRecoveryEnabled })) return "unavailable";
    /*
    FNXC:TaskWedgeNotifications 2026-08-10-04:35:
    `getTask` throws TaskNotFoundError for soft-deleted rows instead of returning
    undefined. A missing or unreadable live row cannot prove an actionable park,
    so fail quiet and preserve enqueueWedgeHandling's never-reject contract.
    */
    let liveTask: Task;
    try {
      liveTask = this.store.getTask ? (await this.store.getTask(task.id)) ?? task : task;
    } catch (error) {
      const detail = isTaskNotFoundError(error) ? "not found" : error instanceof Error ? error.message : String(error);
      schedulerLog.warn(`[notify] ${task.id} wedge live-read failed (${detail}) — suppressed notification`);
      return "unavailable";
    }
    const classification = classifyTerminalFailureAutoRecoveryForTask(liveTask, { autoRecoveryEnabled: this.autoRecoveryEnabled });
    const requestedAutoRecoveryEscalation = options?.source === "auto-recovery-escalation";
    const ownEscalation = requestedAutoRecoveryEscalation
      || (suppliedDescriptor === undefined && classification.action === "notify");
    /*
    FNXC:TaskWedgeNotifications 2026-08-10-20:32:
    The sweep can hold a snapshot while a manual retry, reset, or another engine
    advances the live row. A source-tagged terminal-failed dispatch is valid only
    while the live budget still owes the same escalation; otherwise it must not
    turn a stale snapshot into an alert or delivery stamp. Non-terminal supplied
    descriptors retain their existing behavior and never become budget stamps.
    */
    if (
      requestedAutoRecoveryEscalation
      && suppliedDescriptor?.reasonKey === "terminal-failed"
      && classification.action !== "notify"
    ) return "unavailable";
    const recoveryOwner = describeTaskRecoveryOwner(liveTask);
    if (recoveryOwner && !ownEscalation) {
      // Recovery ownership is not a wedge episode. Resolve only an episode we
      // can prove active, avoiding a write/claim for a never-notified snapshot.
      await this.clearPendingWedgeNotification(task.id);
      if (this.activeWedgeReasons.has(task.id) || liveTask.wedgeNotification?.status === "active") {
        this.activeWedgeReasons.delete(task.id);
        await this.store.claimTaskWedgeNotificationEpisode?.(task.id, null);
      }
      return "unavailable";
    }
    /*
    FNXC:TaskWedgeNotifications 2026-08-10-04:35:
    Archived/complete lanes and deleted rows may retain failed snapshots, but they
    are terminal history rather than operator-actionable parks. Revalidate a
    self-healing descriptor's live pause and auto-merge hold too; only role
    membership is stable when workflows rename lifecycle columns.
    */
    const terminalLanes = await resolveProjectColumnsForRoles(this.store, ["complete", "archived"]);
    const liveRowCannotBeWedge = liveTask.deletedAt != null || terminalLanes.has(liveTask.column);
    const suppliedDescriptorIsHeldOrProgressing = suppliedDescriptor != null
      && (liveTask.paused === true || liveTask.userPaused === true || liveTask.autoMerge === false || isTaskProgressing(liveTask));
    const descriptor = liveRowCannotBeWedge || suppliedDescriptorIsHeldOrProgressing
      ? null
      : suppliedDescriptor ?? describeTaskWedge(liveTask);
    task = liveTask;
    let episode: string | undefined;
    if (!descriptor) {
      /*
      FNXC:TaskWedgeNotifications 2026-07-22-14:45:
      A self-healing no-action escalation may remain in `in-review` without a
      status/error mutation. Incidental task updates are not resolution evidence;
      resolve only when the lifecycle has visibly resumed in an active or terminal
      column, or when it carries a non-failed workflow status.
      */
      const isActiveSelfHealingNoAction = task.wedgeNotification?.status === "active"
        && task.wedgeNotification.reasonKey.startsWith("self-healing-no-action:");
      // FNXC:TaskWedgeNotifications 2026-07-22-15:00: A no-action task normally
      // stays in review, so arbitrary in-review/status writes are not resolution
      // evidence. Only an active owner state or real lifecycle advance can close it.
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-21:20 (the blocker is gone, so the conversion lands):
      These four ids are an enumeration of "every lane except review" — the lanes whose occupancy
      proves a wedged card's lifecycle has visibly resumed. On a renamed board none of them matched,
      so a recovered card's episode was never resolved and the operator kept an open wedge alert for
      work that had moved on.

      TWO EARLIER PASSES CONVERTED THIS AND REVERTED IT, both times after
      `task-wedge-notification.test.ts > "sends one actionable push and mailbox message per active
      terminal episode"` went red with `expected 2 calls, got 1`. Their diagnosis was right and worth
      restating: this branch RESOLVES an episode, `handleTaskUpdated` starts it fire-and-forget from a
      synchronous listener, and ANY await introduced before the resolve lets a re-wedge arriving close
      behind reach `claim` while the previous episode is still active — `claimed: false`, second
      notification dropped. Column resolution needs an await, so the conversion could not be made
      safe from inside this branch.

      It is safe now because `enqueueWedgeHandling` serialises wedge handling PER TASK, so
      resolve-then-claim keeps its order however many awaits either branch acquires. That is the
      wedge-episode-contract change the earlier notes said this was waiting on; it lands in the same
      commit, and the named acceptance test is the gate on both halves.

      MEMBERSHIP over the four roles, not first-match: "has this card moved on" can be true of more
      than one lane per role on a renamed board, and a first-match answer would silently ignore the
      others. Legacy-seeded, so an unconverted board resolves exactly the four ids it used to compare.
      */
      const progressedLanes = await resolveProjectColumnsForRoles(this.store, ["hold", "countsTowardWip", "complete", "archived"]);
      const hasProgressed = progressedLanes.has(task.column)
        || (!isActiveSelfHealingNoAction && typeof task.status === "string" && task.status !== "failed")
        || (isActiveSelfHealingNoAction && ["queued", "planning", "in-progress", "merging", "merging-pr", "merged", "done"].includes(task.status ?? ""));
      if (hasProgressed) {
        await this.clearPendingWedgeNotification(task.id);
        this.activeWedgeReasons.delete(task.id);
        await this.store.claimTaskWedgeNotificationEpisode?.(task.id, null);
      }
      return "unavailable";
    }
    const source: "auto" | "supplied" = suppliedDescriptor === undefined ? "auto" : "supplied";
    if (this.wedgeNotificationSettleMs > 0) {
      const marked = typeof this.store.markTaskWedgeNotificationPending === "function"
        ? await this.store.markTaskWedgeNotificationPending(task.id, { ...descriptor, source }, { staleAfterMs: this.resolveStaleHoldHorizonMs() })
        : this.markFallbackWedgePending(task, descriptor, { staleAfterMs: this.resolveStaleHoldHorizonMs() });
      const existing = this.pendingWedgeNotifications.get(task.id);
      this.pendingWedgeNotifications.set(task.id, { ...existing, descriptor, source, since: marked.since, task });
      if (marked.armed) {
        this.armPendingWedgeTimer(task.id, this.wedgeNotificationSettleMs);
        return "unavailable";
      }
      const completion = await this.runPendingWedgeCompletion(task.id);
      if ((completion.outcome === "held" || completion.outcome === "rearmed") && !this.pendingWedgeNotifications.get(task.id)?.timer) {
        this.armPendingWedgeTimer(task.id, completion.remainingMs ?? this.wedgeNotificationSettleMs);
      }
      return completion.outcome === "delivered" ? "delivered" : completion.outcome === "suppressed" ? "suppressed" : "unavailable";
    }
    await this.clearPendingWedgeNotification(task.id);
    const isAutoRecoveryEscalationDispatch = ownEscalation && descriptor.reasonKey === "terminal-failed";
    if (isAutoRecoveryEscalationDispatch && classification.action === "notify" && classification.reason === "budget-exhausted") {
      try {
        await this.store.markTerminalFailureAutoRecoveryBudgetExhausted?.(task.id, { maxAttempts: MAX_TERMINAL_FAILURE_AUTO_RETRIES });
      } catch (error) {
        schedulerLog.debug(`[notify] ${task.id} could not mark terminal recovery exhaustion: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.store.claimTaskWedgeNotificationEpisode) {
      const claim = await this.store.claimTaskWedgeNotificationEpisode(task.id, descriptor.reasonKey);
      if (!claim.claimed || !claim.episodeId) {
        /*
        FNXC:TaskWedgeNotifications 2026-08-10-20:40:
        A durable episode-CAS decline proves an equivalent terminal-failed dispatch is already
        inside the current cooldown. Stamp this escalation at the shared seam, subject to the
        store's budget/owed-marker floor validation, so a service-first suppression cannot wait
        for a later sweep and reopen into a repeat alert. The fallback episode is intentionally
        excluded: its process-local cooldown cannot prove a durable budget delivery.
        */
        if (isAutoRecoveryEscalationDispatch && classification.action === "notify") {
          try {
            await this.store.markTerminalFailureAutoRecoveryEscalationDelivered?.(task.id, {
              dispatchOutcome: "suppressed",
              escalationReason: classification.reason,
            });
          } catch (error) {
            schedulerLog.debug(`[notify] ${task.id} could not stamp suppressed terminal recovery delivery: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return "suppressed";
      }
      episode = claim.episodeId;
    } else {
      episode = this.claimFallbackWedgeNotificationEpisode(task.id, descriptor.reasonKey, task.updatedAt);
      if (!episode) return "suppressed";
    }
    const link = buildNtfyClickUrl({ dashboardHost: this.dashboardHost, projectId: this.options.projectId, taskId: task.id });
    const content = [
      `**${formatTaskIdentifier(task)} needs operator action**`, "", descriptor.reason,
      ...(descriptor.gate ? [`Gate: \`${descriptor.gate}\`.`] : []),
      `Recommended action: ${descriptor.action}`,
      ...(link ? ["", `[Open ${task.id}](${link})`] : []),
    ].join("\n");
    const payload: NotificationPayload = {
      taskId: task.id, taskTitle: task.title, taskDescription: task.description, event: "task-wedged",
      // Bounded descriptor text is operator-facing provider content, never audit metadata.
      metadata: { wedgeReason: descriptor.reasonKey, reason: descriptor.reason, action: descriptor.action, ...(descriptor.gate ? { gate: descriptor.gate } : {}), notificationDedupeKey: `task-wedge:${episode}` },
    };
    // Push and mailbox delivery are independently best-effort.
    void this.dispatch("task-wedged", payload);
    try {
      await this.options.messageStore?.sendMessageOnce?.({
        fromId: "system", fromType: "system", toId: DASHBOARD_USER_ID, toType: "user", type: "system",
        content, metadata: { taskId: task.id, kind: "task-wedge", wedgeReason: descriptor.reasonKey, ...(descriptor.gate ? { gate: descriptor.gate } : {}) },
      }, `task-wedge:${episode}`);
    } catch (error) {
      schedulerLog.log(`[notify] ${task.id} wedge mailbox message failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isAutoRecoveryEscalationDispatch && classification.action === "notify") {
      try {
        await this.store.markTerminalFailureAutoRecoveryEscalationDelivered?.(task.id, {
          dispatchOutcome: "delivered",
          escalationReason: classification.reason,
        });
      } catch (error) {
        schedulerLog.debug(`[notify] ${task.id} could not stamp terminal recovery delivery: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return "delivered";
  }

  /*
  FNXC:TaskWedgeNotifications 2026-08-11-18:28:
  Deferred wedge delivery is serialized per task. The timer enters through the public wrapper;
  in-chain observations call the queue-free core to avoid awaiting a successor link of themselves.
  Lightweight stores retain this hold only in memory: restart durability requires the production
  pending-marker API, and stores without getTask can only observe recovery on later task updates.
  */
  getWedgeNotificationSettleMs(): number { return this.wedgeNotificationSettleMs; }

  /*
  FNXC:TaskWedgeNotifications 2026-08-11-19:08:
  A restart-lost timer leaves periodic maintenance as the only deferred-delivery driver.
  Keep this horizon beyond the resolved maintenance interval so its next tick observes a
  re-stamped hold as fresh and can deliver it, rather than re-stamping forever.
  */
  private resolveStaleHoldHorizonMs(): number {
    return Math.max(
      this.wedgeNotificationSettleMs * 4,
      this.maintenanceIntervalMs + this.wedgeNotificationSettleMs,
    );
  }

  private markFallbackWedgePending(
    task: Task,
    descriptor: TaskWedgeDescriptor,
    options: { forceRestamp?: boolean; staleAfterMs?: number } = {},
  ): { since: string; armed: boolean; restamped: boolean } {
    const prior = this.pendingWedgeNotifications.get(task.id);
    const sameReason = prior?.descriptor.reasonKey === descriptor.reasonKey;
    const age = prior ? Date.now() - Date.parse(prior.since) : Number.NaN;
    const stale = sameReason
      && typeof options.staleAfterMs === "number"
      && Number.isFinite(options.staleAfterMs)
      && Number.isFinite(age)
      && age > options.staleAfterMs;
    if (sameReason && !options.forceRestamp && !stale) return { since: prior.since, armed: false, restamped: false };
    return { since: new Date().toISOString(), armed: true, restamped: prior != null };
  }

  private armPendingWedgeTimer(taskId: string, delayMs: number): void {
    const pending = this.pendingWedgeNotifications.get(taskId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      const entry = this.pendingWedgeNotifications.get(taskId);
      if (entry) delete entry.timer;
      void this.completePendingWedgeNotification(taskId).then((result) => {
        if (result.outcome === "held" || result.outcome === "rearmed") this.armPendingWedgeTimer(taskId, result.remainingMs ?? this.wedgeNotificationSettleMs);
      }).catch(() => undefined);
    }, Math.max(1, Math.min(delayMs, this.wedgeNotificationSettleMs)));
    timer.unref?.();
    pending.timer = timer;
  }

  private async clearPendingWedgeNotification(taskId: string): Promise<void> {
    const pending = this.pendingWedgeNotifications.get(taskId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pendingWedgeNotifications.delete(taskId);
    try {
      if (typeof this.store.clearTaskWedgeNotificationPending === "function") await this.store.clearTaskWedgeNotificationPending(taskId);
    } catch (error) {
      schedulerLog.debug(`[notify] ${taskId} could not clear pending wedge: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async completePendingWedgeNotification(taskId: string): Promise<PendingWedgeCompletionResult> {
    let result: PendingWedgeCompletionResult = { outcome: "absent" };
    await this.enqueueWedgeHandling(taskId, async () => { result = await this.runPendingWedgeCompletion(taskId); });
    return result;
  }

  private async runPendingWedgeCompletion(taskId: string): Promise<PendingWedgeCompletionResult> {
    try {
      /*
      FNXC:TaskWedgeNotifications 2026-08-11-18:57:
      A zero window is an exit from deferred delivery, not permission for a stale timer or sweep
      candidate to dispatch. New observations still use maybeNotifyTaskWedge's legacy immediate
      branch; existing durable evidence is cleared here to prevent an unwindowed duplicate.
      */
      if (this.wedgeNotificationSettleMs === 0) {
        await this.clearPendingWedgeNotification(taskId);
        return { outcome: "cleared" };
      }
      const cached = this.pendingWedgeNotifications.get(taskId);
      let task: Task | undefined;
      try {
        task = typeof this.store.getTask === "function" ? await this.store.getTask(taskId) : cached?.task;
      } catch {
        await this.clearPendingWedgeNotification(taskId);
        return { outcome: "unreadable" };
      }
      if (!task) {
        await this.clearPendingWedgeNotification(taskId);
        /*
        FNXC:TaskWedgeNotifications 2026-08-11-19:15:
        A completion with neither a live read nor the hold snapshot has no subject
        to revalidate or safely format for delivery. Report it as unreadable rather
        than absent so compatibility-store callers cannot mistake lost evidence for
        a completed deferred episode.
        */
        return { outcome: "unreadable" };
      }
      const durablePending = task.wedgeNotification?.pending;
      if (!durablePending && !cached) return { outcome: "absent" };
      const source = durablePending?.source ?? cached!.source;
      let descriptor: TaskWedgeDescriptor = durablePending
        ? { reasonKey: durablePending.reasonKey, reason: durablePending.reason, action: durablePending.action, ...(durablePending.gate ? { gate: durablePending.gate } : {}) }
        : cached!.descriptor;

      const terminalLanes = await resolveProjectColumnsForRoles(this.store, ["complete", "archived"]);
      const progressedLanes = await resolveProjectColumnsForRoles(this.store, ["hold", "countsTowardWip", "complete", "archived"]);
      const activeSelfHealing = task.wedgeNotification?.status === "active" && task.wedgeNotification.reasonKey.startsWith("self-healing-no-action:");
      const hasProgressed = progressedLanes.has(task.column)
        || (!activeSelfHealing && typeof task.status === "string" && task.status !== "failed")
        || (activeSelfHealing && ["queued", "planning", "in-progress", "merging", "merging-pr", "merged", "done"].includes(task.status ?? ""));
      const suppliedHeldOrProgressing = source === "supplied" && (task.paused === true || task.userPaused === true || task.autoMerge === false || isTaskProgressing(task));
      if (task.deletedAt != null || terminalLanes.has(task.column) || describeTaskRecoveryOwner(task) != null || hasProgressed || suppliedHeldOrProgressing) {
        await this.clearPendingWedgeNotification(taskId);
        return { outcome: "cleared" };
      }

      if (source === "auto") {
        const fresh = describeTaskWedge(task);
        if (!fresh) {
          await this.clearPendingWedgeNotification(taskId);
          return { outcome: "cleared" };
        }
        if (fresh.reasonKey !== descriptor.reasonKey) {
          const marked = typeof this.store.markTaskWedgeNotificationPending === "function"
            ? await this.store.markTaskWedgeNotificationPending(taskId, { ...fresh, source }, { staleAfterMs: this.resolveStaleHoldHorizonMs() })
            : this.markFallbackWedgePending(task, fresh);
          this.pendingWedgeNotifications.set(taskId, { ...cached, descriptor: fresh, source, since: marked.since, task });
          return { outcome: "rearmed", reasonKey: fresh.reasonKey, remainingMs: this.wedgeNotificationSettleMs };
        }
        descriptor = fresh;
      }

      const since = Date.parse(durablePending?.since ?? cached!.since);
      const age = Number.isFinite(since) ? Date.now() - since : Number.POSITIVE_INFINITY;
      if (age > this.resolveStaleHoldHorizonMs()) {
        const marked = typeof this.store.markTaskWedgeNotificationPending === "function"
          ? await this.store.markTaskWedgeNotificationPending(taskId, { ...descriptor, source }, { staleAfterMs: 0 })
          : this.markFallbackWedgePending(task, descriptor, { forceRestamp: true });
        this.pendingWedgeNotifications.set(taskId, { ...cached, descriptor, source, since: marked.since, task });
        return { outcome: "rearmed", reasonKey: descriptor.reasonKey, remainingMs: this.wedgeNotificationSettleMs };
      }
      const remainingMs = this.wedgeNotificationSettleMs - Math.max(0, age);
      if (remainingMs > 0) return { outcome: "held", reasonKey: descriptor.reasonKey, remainingMs };

      const claim = this.store.claimTaskWedgeNotificationEpisode
        ? await this.store.claimTaskWedgeNotificationEpisode(taskId, descriptor.reasonKey)
        : (() => { const episodeId = this.claimFallbackWedgeNotificationEpisode(taskId, descriptor.reasonKey, task.updatedAt); return { episodeId, claimed: episodeId !== undefined }; })();
      await this.clearPendingWedgeNotification(taskId);
      if (!claim.claimed || !claim.episodeId) {
        this.wedgeNotificationSuppressedCount += 1;
        return { outcome: "suppressed", reasonKey: descriptor.reasonKey };
      }
      const payload = this.createTaskPayload(task, "task-wedged", { wedgeReason: descriptor.reasonKey, reason: descriptor.reason, action: descriptor.action, ...(descriptor.gate ? { gate: descriptor.gate } : {}), notificationDedupeKey: `task-wedge:${claim.episodeId}` });
      void this.dispatch("task-wedged", payload);
      const content = `**${formatTaskIdentifier(task)} needs operator action**\n\n${descriptor.reason}\nRecommended action: ${descriptor.action}`;
      try { await this.options.messageStore?.sendMessageOnce?.({ fromId: "system", fromType: "system", toId: DASHBOARD_USER_ID, toType: "user", type: "system", content, metadata: { taskId, kind: "task-wedge", wedgeReason: descriptor.reasonKey } }, `task-wedge:${claim.episodeId}`); } catch { /* mailbox is independently best-effort */ }
      return { outcome: "delivered", reasonKey: descriptor.reasonKey };
    } catch (error) {
      schedulerLog.debug(`[notify] ${taskId} pending wedge completion failed: ${error instanceof Error ? error.message : String(error)}`);
      return { outcome: "unreadable" };
    }
  }

  private claimFallbackWedgeNotificationEpisode(taskId: string, reasonKey: string, updatedAt: string): string | undefined {
    if (this.activeWedgeReasons.get(taskId) === reasonKey) return undefined;

    const now = Date.now();
    const timestamps = this.fallbackWedgeNotificationTimestamps.get(taskId) ?? new Map<string, number>();
    for (const [key, notifiedAt] of timestamps) {
      if (!Number.isFinite(notifiedAt) || notifiedAt > now || now - notifiedAt >= WEDGE_RENOTIFY_COOLDOWN_MS) timestamps.delete(key);
    }
    this.activeWedgeReasons.set(taskId, reasonKey);
    this.fallbackWedgeNotificationTimestamps.set(taskId, timestamps);
    if (timestamps.has(reasonKey)) return undefined;

    timestamps.set(reasonKey, now);
    return `${taskId}:${reasonKey}:${updatedAt}`;
  }

  private isTriageDuplicateDecision(task: Task): boolean {
    return task.paused === true
      && task.pausedReason === "duplicate-decision-required"
      && task.sourceMetadata?.duplicateSource === "triage-marker"
      && typeof task.sourceMetadata.nearDuplicateOf === "string";
  }

  /** Write one durable operator prompt for a duplicate candidate, independent of push configuration. */
  private async writeTriageDuplicateDecisionMailboxMessage(task: Task): Promise<void> {
    try {
      const messageStore = this.options.messageStore;
      if (!messageStore?.sendMessageOnce) {
        return;
      }
      const canonicalTaskId = task.sourceMetadata?.nearDuplicateOf;
      if (typeof canonicalTaskId !== "string") {
        return;
      }
      const link = buildNtfyClickUrl({
        dashboardHost: this.dashboardHost,
        projectId: this.options.projectId,
        taskId: task.id,
      });
      const content = [
        `**${formatTaskIdentifier(task)} needs your decision**`,
        "",
        `It was flagged as a duplicate of ${canonicalTaskId}. Keep it to continue planning, or delete it if the work is already covered.`,
        ...(link ? ["", `[Open ${task.id}](${link})`] : []),
      ].join("\n");
      await messageStore.sendMessageOnce({
        fromId: "system",
        fromType: "system",
        toId: DASHBOARD_USER_ID,
        toType: "user",
        type: "system",
        content,
        metadata: { taskId: task.id, canonicalTaskId, kind: "triage-duplicate-decision" },
      }, `triage-duplicate-decision:${task.id}`);
    } catch (error) {
      schedulerLog.log(
        `[notify] ${task.id} triage duplicate-decision mailbox message failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleTaskMerged = (result: MergeResult): void => {
    void this.handleTaskMergedAsync(result);
  };

  private async handleTaskMergedAsync(result: MergeResult): Promise<void> {
    if (!result.merged) {
      return;
    }

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("task:merged");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    this.maybeNotify(
      result.task.id,
      "merged",
      this.createTaskPayload(result.task, "merged"),
    );
  };

  private handleSettingsUpdated = async (data: { settings: Settings; previous: Settings }): Promise<void> => {
    const { settings, previous } = data;
    this.setNotificationsEnabledFromSettings(settings);
    this.dashboardHost = settings.ntfyDashboardHost;
    this.refreshFailureNotificationSettings(settings);

    if (
      settings.ntfyEnabled !== previous.ntfyEnabled ||
      settings.ntfyTopic !== previous.ntfyTopic ||
      settings.ntfyBaseUrl !== previous.ntfyBaseUrl ||
      settings.ntfyAccessToken !== previous.ntfyAccessToken ||
      settings.ntfyDashboardHost !== previous.ntfyDashboardHost ||
      JSON.stringify(settings.ntfyEvents) !== JSON.stringify(previous.ntfyEvents)
    ) {
      const wasEnabled = Boolean(previous.ntfyEnabled && previous.ntfyTopic);
      const isEnabled = Boolean(settings.ntfyEnabled && settings.ntfyTopic);

      await this.syncNtfyProvider(settings);

      if (isEnabled && !wasEnabled) {
        schedulerLog.debug("NotificationService ntfy enabled");
      } else if (!isEnabled && wasEnabled) {
        schedulerLog.debug("NotificationService ntfy disabled");
      } else if (settings.ntfyTopic !== previous.ntfyTopic) {
        schedulerLog.debug("NotificationService ntfy topic updated");
      } else if (settings.ntfyBaseUrl !== previous.ntfyBaseUrl) {
        schedulerLog.debug("NotificationService ntfy base URL updated");
      } else if (settings.ntfyAccessToken !== previous.ntfyAccessToken) {
        schedulerLog.debug("NotificationService ntfy access token updated");
      } else if (settings.ntfyDashboardHost !== previous.ntfyDashboardHost) {
        schedulerLog.debug("NotificationService ntfy dashboard host updated");
      } else if (JSON.stringify(settings.ntfyEvents) !== JSON.stringify(previous.ntfyEvents)) {
        schedulerLog.debug("NotificationService ntfy events updated");
      }
    }

    if (
      settings.webhookEnabled !== previous.webhookEnabled ||
      settings.webhookUrl !== previous.webhookUrl ||
      settings.webhookFormat !== previous.webhookFormat ||
      JSON.stringify(settings.webhookEvents) !== JSON.stringify(previous.webhookEvents)
    ) {
      await this.syncWebhookProvider(settings);
      schedulerLog.debug("WebhookNotificationProvider config updated");
    }
  };

  private async syncNtfyProvider(settings: Settings): Promise<void> {
    const enabled = Boolean(settings.ntfyEnabled && settings.ntfyTopic);

    if (!enabled) {
      if (this.ntfyProvider) {
        await this.ntfyProvider.shutdown?.();
        this.dispatcher.unregisterProvider(this.ntfyProvider.getProviderId());
        this.ntfyProvider = undefined;
      }
      return;
    }

    if (!this.ntfyProvider) {
      this.ntfyProvider = new NtfyNotificationProvider();
      this.registerProvider(this.ntfyProvider);
    }

    await this.ntfyProvider.initialize?.({
      topic: settings.ntfyTopic,
      ntfyBaseUrl: settings.ntfyBaseUrl ?? this.options.ntfyBaseUrl,
      ntfyAccessToken: settings.ntfyAccessToken,
      dashboardHost: settings.ntfyDashboardHost,
      events: settings.ntfyEvents ?? [...DEFAULT_NTFY_EVENTS],
      projectId: this.options.projectId,
    });
  }

  private async syncWebhookProvider(settings: Settings): Promise<void> {
    const enabled = Boolean(settings.webhookEnabled && settings.webhookUrl);

    if (!enabled) {
      if (this.webhookProvider) {
        await this.webhookProvider.shutdown?.();
        this.dispatcher.unregisterProvider(this.webhookProvider.getProviderId());
        this.webhookProvider = undefined;
      }
      return;
    }

    if (!this.webhookProvider) {
      this.webhookProvider = new WebhookNotificationProvider();
      this.registerProvider(this.webhookProvider);
    }

    await this.webhookProvider.initialize?.({
      webhookUrl: settings.webhookUrl,
      webhookFormat: settings.webhookFormat ?? "generic",
      events: settings.webhookEvents ?? [],
      dashboardHost: settings.ntfyDashboardHost,
      projectId: this.options.projectId,
    });
  }

  private handleMessageSent = (message: Message): void => {
    void this.handleMessageSentAsync(message);
  };

  private handleRoomMessageAdded = (message: ChatRoomMessage): void => {
    void this.handleRoomMessageAddedAsync(message);
  };

  private async handleMessageSentAsync(message: Message): Promise<void> {
    schedulerLog.log(
      `NotificationService.handleMessageSent messageId=${message.id} type=${message.type} notificationsEnabled=${String(this.notificationsEnabled)} hasNtfyProvider=${String(Boolean(this.ntfyProvider))}`,
    );

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("message:sent");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    let eventType: NotificationEvent;
    if (message.type === "agent-to-user") {
      eventType = "message:agent-to-user";
    } else if (message.type === "agent-to-agent") {
      eventType = "message:agent-to-agent";
    } else {
      return;
    }

    const preview = this.createPreview(message.content);

    const taskId = typeof message.metadata?.taskId === "string" ? message.metadata.taskId : undefined;

    const fromName = await this.resolveAgentName(message.fromType, message.fromId, "from");
    const toName = await this.resolveAgentName(message.toType, message.toId, "to");

    this.maybeNotify(message.id, eventType, {
      taskId,
      taskTitle: undefined,
      event: eventType,
      metadata: {
        messageId: message.id,
        fromId: message.fromId,
        fromType: message.fromType,
        ...(fromName ? { fromName } : {}),
        toId: message.toId,
        toType: message.toType,
        ...(toName ? { toName } : {}),
        type: message.type,
        replyToMessageId: message.metadata?.replyTo?.messageId,
        preview,
      },
    });

    schedulerLog.log(
      `NotificationService.handleMessageSent scheduled eventType=${eventType} messageId=${message.id}`,
    );
  }

  private async handleRoomMessageAddedAsync(message: ChatRoomMessage): Promise<void> {
    schedulerLog.log(
      `NotificationService.handleRoomMessageAdded messageId=${message.id} roomId=${message.roomId} role=${message.role} notificationsEnabled=${String(this.notificationsEnabled)}`,
    );

    if (message.role !== "assistant" || message.senderAgentId == null) {
      return;
    }

    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("chat:room:message:added");
      if (!this.notificationsEnabled) {
        return;
      }
    }

    const senderName = await this.resolveAgentName("agent", message.senderAgentId, "from");
    const roomName = (await this.chatStore?.getRoom?.(message.roomId))?.name;
    const preview = this.createPreview(message.content);

    this.maybeNotify(message.id, "message:room", {
      event: "message:room",
      metadata: {
        messageId: message.id,
        roomId: message.roomId,
        ...(roomName ? { roomName } : {}),
        senderAgentId: message.senderAgentId,
        ...(senderName ? { senderName } : {}),
        preview,
        type: "room-assistant",
      },
    });

    schedulerLog.log(
      `NotificationService.handleRoomMessageAdded scheduled eventType=message:room messageId=${message.id}`,
    );
  }

  private async resolveAgentName(
    participantType: Message["fromType"],
    participantId: string,
    direction: "from" | "to",
  ): Promise<string | null> {
    if (participantType !== "agent") {
      return null;
    }

    const resolver = this.options.agentNameResolver;
    if (!resolver) {
      return null;
    }

    try {
      const resolved = await resolver(participantId);
      const trimmed = typeof resolved === "string" ? resolved.trim() : "";
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      schedulerLog.log(
        `NotificationService.handleMessageSent failed to resolve ${direction} agent name agentId=${participantId} error=${message}`,
      );
      return null;
    }
  }

  private createPreview(content: string): string {
    return content.length > 100 ? `${content.slice(0, 100)}…` : content;
  }

  private detachChatStoreListener(chatStore: NotificationChatStore | undefined): void {
    if (typeof chatStore?.off === "function") {
      chatStore.off("chat:room:message:added", this.handleRoomMessageAdded);
    }
  }

  private setNotificationsEnabledFromSettings(settings: Settings): void {
    this.notificationsEnabled = Boolean(
      (settings.ntfyEnabled && settings.ntfyTopic) ||
      (settings.webhookEnabled && settings.webhookUrl),
    );
  }

  async dispatch(eventType: NotificationEvent, payload: NotificationPayload): Promise<void> {
    await this.dispatchConfirmed(eventType, payload);
  }

  async dispatchConfirmed(eventType: NotificationEvent, payload: NotificationPayload): Promise<boolean> {
    if (!this.notificationsEnabled) {
      await this.refreshNotificationState("manual-dispatch");
      if (!this.notificationsEnabled) {
        return false;
      }
    }

    const dedupTaskId = payload.taskId ?? "global";
    const metadataDedupeKey = typeof payload.metadata?.notificationDedupeKey === "string"
      ? payload.metadata.notificationDedupeKey.trim()
      : "";
    const key = metadataDedupeKey.length > 0 ? metadataDedupeKey : `${dedupTaskId}:${eventType}`;
    if (this.notifiedEvents.has(key)) {
      return true;
    }

    /*
    FNXC:OAuthNotifications 2026-07-14-15:46:
    OAuth expiry monitoring needs confirmed delivery before it starts the durable 12-hour alert cooldown. Its confirmed dispatch path therefore awaits provider results and reports whether any provider succeeded; existing workflow dispatch keeps its Promise<void> contract and fire-and-forget task events remain on maybeNotify.
    */
    this.notifiedEvents.add(key);
    try {
      const results = await this.dispatcher.dispatch(eventType, payload);
      const delivered = results.some((result) => result.success);
      if (!delivered) {
        this.notifiedEvents.delete(key);
      }
      return delivered;
    } catch (error) {
      this.notifiedEvents.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      schedulerLog.log(`NotificationService.dispatch failed key=${key} error=${message}`);
      return false;
    }
  }

  private async refreshNotificationState(reason: string): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }

    this.refreshInFlight = (async () => {
      const settings = await this.store.getSettings();
      this.setNotificationsEnabledFromSettings(settings);
      this.refreshFailureNotificationSettings(settings);
      await this.syncNtfyProvider(settings);
      await this.syncWebhookProvider(settings);
      schedulerLog.debug(`NotificationService refreshed notification state reason=${reason} enabled=${String(this.notificationsEnabled)}`);
    })();

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private refreshFailureNotificationSettings(settings: Settings): void {
    // Fail open when no maintenance pass can own the retry budget; classic wedge notification remains available.
    this.autoRecoveryEnabled = settings.autoRecovery?.mode !== "off"
      && (settings.maintenanceIntervalMs === undefined || settings.maintenanceIntervalMs > 0);
    this.failureNotificationDelayMs =
      typeof settings.failureNotificationDelayMs === "number" && settings.failureNotificationDelayMs >= 0
        ? settings.failureNotificationDelayMs
        : this.failedNotificationGraceMs;
    this.failureNotificationMode = settings.failureNotificationMode ?? "sticky-only";
    this.wedgeNotificationSettleMs = typeof settings.wedgeNotificationSettleMs === "number" && Number.isFinite(settings.wedgeNotificationSettleMs) && settings.wedgeNotificationSettleMs >= 0
      ? settings.wedgeNotificationSettleMs
      : this.options.wedgeNotificationSettleMs ?? 300_000;
    this.maintenanceIntervalMs = typeof settings.maintenanceIntervalMs === "number"
      && Number.isFinite(settings.maintenanceIntervalMs)
      && settings.maintenanceIntervalMs > 0
      ? settings.maintenanceIntervalMs
      : 900_000;
  }

  private async maybeNotifyImmediateFailure(task: Task): Promise<void> {
    const liveTask = this.store.getTask ? (await this.store.getTask(task.id)) ?? task : task;
    if (
      liveTask.status !== "failed"
      || describeTaskRecoveryOwner(liveTask)
      || describeTaskWedge(liveTask)
    ) {
      this.failureNotificationSuppressedCount += 1;
      return;
    }
    this.maybeNotify(liveTask.id, "failed", this.createTaskPayload(liveTask, "failed"));
  }

  private scheduleFailureNotification(task: Task): void {
    if (this.pendingFailureNotifications.has(task.id)) {
      return;
    }

    this.pendingFailureStartTimes.set(task.id, Date.now());
    const payload = this.createTaskPayload(task, "failed");
    const timer = setTimeout(() => {
      void this.fireDeferredFailureNotification(task.id);
    }, this.failureNotificationDelayMs);
    timer.unref?.();
    this.pendingFailureNotifications.set(task.id, { timer, payload });
  }

  private async maybeSuppressTransientFailedNotification(task: Task, reason: string): Promise<void> {
    if (!this.pendingFailureNotifications.has(task.id)) {
      return;
    }

    const currentTask = (await this.store.getTask?.(task.id)) ?? task;
    const hasAutoRecoveredLog = currentTask.log.some((entry) => /^Auto-recovered:/.test(entry.action));
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (fleet phase):
    Placed after the `pendingFailureNotifications.has` early return above, so only a task with a
    failure notification actually in flight resolves a workflow here.
    */
    const suppressLifecycle = await this.resolveLifecycleColumnsForTask(task.id);
    const movedToDone = currentTask.column === (suppressLifecycle?.complete ?? "done");
    const mergeConfirmed = currentTask.mergeDetails?.mergeConfirmed === true;
    const recoveredStatus = currentTask.status !== "failed" && hasAutoRecoveredLog;

    if (!movedToDone && !mergeConfirmed && !recoveredStatus) {
      return;
    }

    this.cancelPendingFailureNotification(task.id, reason);
  }

  private cancelPendingFailureNotification(taskId: string, reason: string): void {
    const pending = this.pendingFailureNotifications.get(taskId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingFailureNotifications.delete(taskId);
    const startedAt = this.pendingFailureStartTimes.get(taskId);
    this.pendingFailureStartTimes.delete(taskId);
    const elapsedMs = typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : 0;
    this.failureNotificationSuppressedCount += 1;
    schedulerLog.debug(`NotificationService.maybeNotify suppressed transient failed key=${taskId}:failed (${reason}, ${elapsedMs}ms)`);
  }

  private async fireDeferredFailureNotification(taskId: string): Promise<void> {
    const pending = this.pendingFailureNotifications.get(taskId);
    if (!pending) {
      return;
    }

    this.pendingFailureNotifications.delete(taskId);
    this.pendingFailureStartTimes.delete(taskId);

    const task = await this.store.getTask?.(taskId);
    if (!task) {
      return;
    }

    if (task.status !== "failed") {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.debug(`[notify] ${taskId} no longer failed at dispatch time — suppressed notification`);
      return;
    }

    /*
    FNXC:TaskWedgeNotifications 2026-08-05-04:53:
    A grace timer owns only delayed generic delivery, never the task lifecycle.
    Re-check durable recovery ownership here so a retry scheduled after the
    original failed event produces neither a mailbox row nor a provider dispatch.
    */
    if (describeTaskRecoveryOwner(task)) {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.debug(`[notify] ${taskId} recovery-owned failure at dispatch time — suppressed notification`);
      return;
    }

    // A previously generic failure can become a terminal wedge while its grace
    // timer is pending. The wedge path owns delivery and its durable episode
    // idempotency; never let this delayed generic event become a second alert.
    if (describeTaskWedge(task)) {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.debug(`[notify] ${taskId} classified terminal wedge at dispatch time — suppressed generic failed notification`);
      return;
    }

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (fleet phase):
    Reached only after the transient-merge and wedge classifications above have both declined to
    suppress, so this is already the narrow tail of the deferred-failure path.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-06:40 (PR #2722 review — the SECOND site, which my own
    first pass missed):
    Same defect as the moved-to-review guard above: `.review` reads `mergeOrchestration` only, so a
    lane carrying `human-review` alone resolved to nothing and this fell back to the literal. Under
    `failureNotificationMode: "terminal-only"` that means a task failing in a renamed review lane is
    not treated as terminal, and its failure notification is deferred forever.

    Recording that I fixed one site and shipped the other: I converted the moved-to-review guard and
    did not grep this file for the remaining `.review` reads — the exact Surface Enumeration failure I
    had been flagging in other people's PRs the same day. Both reads in this file now go through the
    same set.
    */
    const isTerminal = task.paused === true
      || (await this.resolveReviewColumnsForTask(task.id)).has(task.column);
    if (this.failureNotificationMode === "terminal-only" && !isTerminal) {
      this.failureNotificationSuppressedCount += 1;
      schedulerLog.debug(`[notify] ${taskId} non-terminal failure — suppressed (mode=terminal-only)`);
      return;
    }

    const pausedTask = task as Task & { pausedReason?: string };
    let eventType: NotificationEvent = "failed";
    if (
      pausedTask.paused === true &&
      pausedTask.pausedReason === "dispatch-storm" &&
      DEFAULT_NTFY_EVENTS.includes("failed:auto-paused" as (typeof DEFAULT_NTFY_EVENTS)[number])
    ) {
      eventType = "failed:auto-paused" as NotificationEvent;
    }

    this.maybeNotify(task.id, eventType, eventType === "failed" ? pending.payload : this.createTaskPayload(task, eventType));
  }

  getMetrics(): { failureNotificationSuppressedCount: number; wedgeNotificationSuppressedCount: number } {
    return { failureNotificationSuppressedCount: this.failureNotificationSuppressedCount, wedgeNotificationSuppressedCount: this.wedgeNotificationSuppressedCount };
  }

  getPendingFailureCount(): number {
    return this.pendingFailureNotifications.size;
  }

  private isMergeBackedTerminalTask(task: Task): boolean {
    return task.prInfo?.status === "merged" ||
      task.mergeDetails?.mergeConfirmed === true ||
      task.mergeDetails?.noOpMerge === true ||
      typeof task.mergeDetails?.mergedAt === "string";
  }

  private classifyWorkflowTransitionNotification(
    task: Task,
    reviewLane?: string,
  ): { event: NotificationEvent; metadata: Record<string, unknown> } | null {
    /*
     * FNXC:WorkflowNotifications 2026-06-29-11:50:
     * Workflow-specific operator waits should notify from the durable task update that already represents the wait, not from a new lifecycle bus. Plan/remediation await-input, workflow CLI approval, manual merge holds, and workflow recovery requeues each use a stable dedupe key so repeated task:updated emissions stay quiet while unrelated task notifications can still fire.
     */
    if (task.status === "awaiting-user-input" && this.isWorkflowAwaitingUserInput(task)) {
      return {
        event: "planning-awaiting-input",
        metadata: {
          notificationDedupeKey: `workflow-transition:${task.id}:awaiting-user-input`,
          notificationKind: "workflow-awaiting-user-input",
          workflowStatus: task.status,
          pausedReason: task.pausedReason,
        },
      };
    }

    if (task.status === "awaiting-cli-approval" && task.pausedReason?.startsWith("workflow-cli-approval:")) {
      return {
        event: "cli-agent-awaiting-input",
        metadata: {
          notificationDedupeKey: `workflow-transition:${task.id}:awaiting-cli-approval`,
          notificationKind: "workflow_cli_approval",
          workflowStatus: task.status,
          pausedReason: task.pausedReason,
        },
      };
    }

    const typedWorkflowTransition = this.workflowTransitionNotificationMarker(task);
    if (task.status !== "failed" && (this.isManualMergeHold(task, reviewLane) || typedWorkflowTransition?.kind === "manual-merge-hold")) {
      return {
        event: "workflow-notify",
        metadata: {
          notificationDedupeKey: typedWorkflowTransition?.transitionId
            ? `workflow-transition:${task.id}:${typedWorkflowTransition.transitionId}`
            : `workflow-transition:${task.id}:manual-merge-hold`,
          notificationKind: "manual_merge_hold",
          title: `Manual merge needed for ${task.id}`,
          message: "Workflow is holding for manual merge action.",
          pausedReason: task.pausedReason,
          ...(typedWorkflowTransition?.nodeId ? { nodeId: typedWorkflowTransition.nodeId } : {}),
          ...(typedWorkflowTransition?.reason ? { reason: typedWorkflowTransition.reason } : {}),
        },
      };
    }

    if (task.status !== "failed" && typedWorkflowTransition?.kind === "recovery-requeue") {
      return {
        event: "workflow-notify",
        metadata: {
          notificationDedupeKey: `workflow-transition:${task.id}:${typedWorkflowTransition.transitionId}`,
          notificationKind: "workflow_recovery_requeue",
          title: `Workflow requeued ${task.id}`,
          message: "Workflow recovery moved the task back to todo for another execution pass.",
          ...(typedWorkflowTransition.nodeId ? { nodeId: typedWorkflowTransition.nodeId } : {}),
          ...(typedWorkflowTransition.reason ? { reason: typedWorkflowTransition.reason } : {}),
        },
      };
    }

    return null;
  }

  private isWorkflowAwaitingUserInput(task: Task): boolean {
    if (!task.paused) {
      return false;
    }
    const pausedReason = task.pausedReason ?? "";
    const latest = this.latestLogAction(task);
    return pausedReason.startsWith("workflow-input:")
      || latest.startsWith("Workflow paused for user input")
      || (latest.startsWith("Workflow step ") && latest.includes(" is waiting for your input:"));
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-08-01-07:42:
  `task:updated` remains a synchronous listener: its prologue schedules wedge and mailbox work before
  notification classification, so resolving workflow IR here would defer that ordering and make the
  lane conversion inert under PostgreSQL's default-only sync resolver.

  FN-8658 instead carries the emitter's cache-warmed `TaskMoveLanes` answer on the event. The review
  lane is passed explicitly through this synchronous chain, while `enqueueWedgeHandling` already
  serializes resolve-then-claim wedge episodes per task. Missing or blank metadata means unknown, not
  legacy, and preserves the established `in-review` fallback exactly.
  */
  private isManualMergeHold(task: Task, reviewLane?: string): boolean {
    const resolvedReviewLane = reviewLane?.trim() || "in-review";
    return task.column === resolvedReviewLane && task.pausedReason === "manual-hold";
  }

  private workflowTransitionNotificationMarker(task: Task): Task["workflowTransitionNotification"] | undefined {
    const marker = task.workflowTransitionNotification;
    if (!marker || marker.column !== task.column) {
      return undefined;
    }
    return marker;
  }

  private latestLogAction(task: Task): string {
    return task.log.at(-1)?.action ?? "";
  }

  private createTaskPayload(task: Task, event: NotificationEvent, metadata?: Record<string, unknown>): NotificationPayload {
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      event,
      ...(metadata ? { metadata } : {}),
    };
  }

  private maybeNotify(taskId: string, eventType: NotificationEvent, payload: NotificationPayload): void {
    const metadataDedupeKey = typeof payload.metadata?.notificationDedupeKey === "string"
      ? payload.metadata.notificationDedupeKey.trim()
      : "";
    /*
     * FNXC:ToolPermissionNotifications 2026-06-27-00:00:
     * Some notification surfaces are not task-lifecycle events. Honor a caller-provided dedupe key so CLI tool-permission prompts can suppress repeated telemetry records without suppressing unrelated future task notifications.
     */
    const key = metadataDedupeKey.length > 0 ? metadataDedupeKey : `${taskId}:${eventType}`;
    if (this.notifiedEvents.has(key)) {
      schedulerLog.debug(`NotificationService.maybeNotify suppressed duplicate key=${key}`);
      return;
    }

    this.notifiedEvents.add(key);
    schedulerLog.debug(`NotificationService.maybeNotify dispatching key=${key}`);
    this.dispatcher.dispatch(eventType, payload).then((results) => {
      if (results.some((result) => result.success)) {
        return;
      }
      this.notifiedEvents.delete(key);
      schedulerLog.log(
        `NotificationService.maybeNotify no successful providers for key=${key} results=${JSON.stringify(results)}`,
      );
    }).catch((error) => {
      this.notifiedEvents.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      schedulerLog.log(`NotificationService.maybeNotify dispatch failed key=${key} error=${message}`);
    });
  }
}
