import { resolveTaskLifecycleColumns } from "@fusion/core";
import type { AsyncDataLayer, Task, WorkflowIr } from "@fusion/core";
import type { PluginContext } from "@fusion/plugin-sdk";
import { notificationCard } from "./cards.js";
import { diffSnapshots } from "./notifications/diff.js";
import { changedSnapshotRows, pruneMissing, readSnapshot, writeSnapshot } from "./notifications/store.js";
import type { NotificationEvent, SnapshotRow } from "./notifications/types.js";
import { getNotifyColumns, getPollingIntervalMs } from "./settings.js";
import type { GlassesTransport } from "./transport.js";

export interface NotifierDeps {
  taskStore: PluginContext["taskStore"];
  layer: AsyncDataLayer;
  transport: GlassesTransport;
  settings: PluginContext["settings"];
  logger?: PluginContext["logger"];
  pluginId: string;
  now?: () => Date;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  snapshotStore?: {
    read(layer: AsyncDataLayer): Promise<Map<string, SnapshotRow>>;
    write(layer: AsyncDataLayer, rows: ReadonlyArray<SnapshotRow>): Promise<void>;
    prune(
      layer: AsyncDataLayer,
      presentTaskIds: ReadonlySet<string>,
      snapshot: ReadonlyMap<string, SnapshotRow>,
    ): Promise<number>;
  };
}

export interface Notifier {
  start(): void;
  stop(): Promise<void>;
  pollOnce(): Promise<NotificationEvent[]>;
  peekPending(limit?: number): NotificationEvent[];
  drainPending(limit?: number): NotificationEvent[];
  ack(taskIds: ReadonlySet<string>): number;
  lastPolledAt(): string | null;
  getLastPollTime(): string | null;
}

const PENDING_CAP = 200;

export function createNotifier(deps: NotifierDeps): Notifier {
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const snapshotStore = deps.snapshotStore ?? {
    read: readSnapshot,
    write: writeSnapshot,
    prune: pruneMissing,
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let running = false;
  let stopped = false;
  let inFlightPromise: Promise<NotificationEvent[]> | null = null;
  let pending: NotificationEvent[] = [];
  let lastPollIso: string | null = null;

  const nowIso = () => (deps.now?.() ?? new Date()).toISOString();

  const bounded = (items: NotificationEvent[]) => {
    if (items.length <= PENDING_CAP) return items;
    return items.slice(items.length - PENDING_CAP);
  };

  const performPoll = async (): Promise<NotificationEvent[]> => {
    if (stopped) return [];
    if (inFlight) {
      deps.logger?.debug?.("skip overlapping poll", { pluginId: deps.pluginId });
      return [];
    }

    inFlight = true;
    try {
      const tasks = (await deps.taskStore.listTasks({ includeArchived: false })) as Task[];
      const snapshot = await snapshotStore.read(deps.layer);
      const notifyOnColumns = new Set(getNotifyColumns(deps.settings));
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-17:05 (#2852 review — greptile P2, and it is right):
      Each card's OWN complete lane, resolved per task and ONLY when the flag that consumes it is on.

      `diffSnapshots` declared a per-task `completeColumnsByTaskId` that this — its only caller —
      never built, so its completion test fell through to the literal `"done"` on every real poll.
      That is the unwired-lane-parameter class, and it is what this change set exists to fix.

      MY FIRST FIX USED THE WRONG SHAPE, which is worth recording because I wrote the warning against
      it myself. I replaced the per-task map with a flat set from `resolveProjectColumnsForRoles`
      because it was one read instead of N. But that helper is the READ-shaped answer: it ALWAYS
      unions the legacy `done` in, which is inert for a query and a false positive for a per-card
      decision. A workflow that declares `shipped` as its complete lane and reuses `done` as an
      ordinary lane would have fired a "completed" notification for live work. The header of
      `project-lane-vocabulary.ts` names this exact mistake — "answering a per-card question from
      this union" — and I made it anyway, one module over.

      The original author's shape was correct and their comment said why: the poll spans the whole
      board, so one workflow's complete column can be another workflow's WIP column. Restored.

      THE COST OBJECTION IS ANSWERED BY THE GATE, not by the shape. `alsoNotifyOnDone` decides
      whether the map is consumed at all, and it is `false` here today — so the per-task reads cost
      exactly nothing now, and the day someone enables the flag they get the correct answer rather
      than a cheap wrong one. An IR cache is shared across the tasks so distinct workflows, not
      distinct cards, drive the resolution count.

      Best-effort per card: a card whose workflow cannot be resolved is simply absent from the map
      and falls back to the documented legacy default, rather than dropping the whole poll.
      */
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-17:10 (found while closing #2852's review — REPORTED,
      not fixed):

      THIS CONSTANT MAKES THE WHOLE COMPLETION PATH DEAD, AND THE SEAM CHECKER STILL READS IT AS WIRED.

      `alsoNotifyOnDone` is a hardcoded `false` with no setting behind it — grep it: the only writer is
      this line. So the block below never runs, `completeColumnsByTaskId` is ALWAYS `undefined`, and
      `diffSnapshots`'s `isComplete && opts.alsoNotifyOnDone` can never fire. The per-task lane
      resolution this change set exists to wire is therefore still inert in production, one level
      further down than the omission it replaced.

      AND THE INSTRUMENT CANNOT SEE IT. `check-inert-flag-seams.mjs` asks whether a call site SUPPLIES
      the argument. Line 128 does supply it — as a variable that is always `undefined` because a
      constant `false` guards its construction. "Supplied" and "supplied with a real value" are
      different questions, and only the first is being asked. This is the sharpest instance of the
      class the checker was built for, sitting inside the checker's own blind spot.

      LEFT AS-IS DELIBERATELY. Turning this into a setting is a behaviour change — it makes the
      glasses start emitting completion notifications nobody has opted into — and that belongs to
      whoever owns this plugin's UX, not to a conversion batch. What must not happen is the seam being
      counted as fixed. Recorded here so the count is read with the caveat attached.
      */
      const alsoNotifyOnDone = false;
      let completeColumnsByTaskId: Map<string, ReadonlySet<string>> | undefined;
      if (alsoNotifyOnDone) {
        const irCache = new Map<string, WorkflowIr>();
        completeColumnsByTaskId = new Map();
        for (const task of tasks) {
          try {
            const complete = (await resolveTaskLifecycleColumns(
              deps.taskStore as Parameters<typeof resolveTaskLifecycleColumns>[0],
              task.id,
              irCache,
            ))?.complete;
            if (complete) completeColumnsByTaskId.set(task.id, new Set([complete]));
          } catch (err) {
            deps.logger?.debug?.("could not resolve complete lane for task", { err, pluginId: deps.pluginId, taskId: task.id });
          }
        }
      }
      const events = diffSnapshots(snapshot, tasks, { notifyOnColumns, alsoNotifyOnDone, completeColumnsByTaskId });
      const taskMap = new Map(tasks.map((task) => [task.id, task] as const));

      for (const event of events) {
        const task = taskMap.get(event.taskId);
        if (!task) continue;
        try {
          await deps.transport.pushCard(notificationCard(task, event.reason));
        } catch (err) {
          deps.logger?.error?.("failed to push notification card", { err, pluginId: deps.pluginId, taskId: task.id });
        }
      }

      pending = bounded([...pending, ...events]);
      const currentRows = tasks.map((task) => ({
        taskId: task.id,
        lastColumn: task.column,
        updatedAt: task.updatedAt,
      }));
      const presentTaskIds = new Set(tasks.map((task) => task.id));
      const changedRows = changedSnapshotRows(snapshot, currentRows);
      if (changedRows.length > 0) {
        await snapshotStore.write(deps.layer, changedRows);
      }
      await snapshotStore.prune(deps.layer, presentTaskIds, snapshot);
      lastPollIso = nowIso();
      return events;
    } catch (err) {
      deps.logger?.error?.("notifier poll failed", { err, pluginId: deps.pluginId });
      return [];
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      void this.pollOnce();
      const intervalMs = Math.max(5000, getPollingIntervalMs(deps.settings));
      timer = setIntervalImpl(() => {
        if (stopped) return;
        void this.pollOnce();
      }, intervalMs);
    },

    async stop() {
      if (!running && !timer) return;
      stopped = true;
      running = false;
      if (timer) {
        clearIntervalImpl(timer);
        timer = undefined;
      }
      if (inFlightPromise) {
        await inFlightPromise.catch(() => undefined);
      }
    },

    pollOnce() {
      const poll = performPoll();
      inFlightPromise = poll;
      return poll.finally(() => {
        if (inFlightPromise === poll) inFlightPromise = null;
      });
    },

    peekPending(limit = 50) {
      const max = Math.max(0, Math.floor(limit));
      return pending.slice(0, max);
    },

    drainPending(limit = 50) {
      const max = Math.max(0, Math.floor(limit));
      const drained = pending.slice(0, max);
      pending = pending.slice(drained.length);
      return drained;
    },

    ack(taskIds: ReadonlySet<string>) {
      const before = pending.length;
      pending = pending.filter((event) => !taskIds.has(event.taskId));
      return before - pending.length;
    },

    lastPolledAt() {
      return lastPollIso;
    },

    getLastPollTime() {
      return lastPollIso;
    },
  };
}
