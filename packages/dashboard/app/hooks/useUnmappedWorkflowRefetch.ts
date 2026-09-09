import { useCallback, useEffect, useRef } from "react";
import type { BoardWorkflowsPayload } from "../api";
import type { Task } from "@fusion/core";

/*
FNXC:WorkflowBoard 2026-07-29-00:00 (U12):
EXTRACTED VERBATIM from Board, so ListView can use the same self-heal instead of
growing a second copy of it. Behaviour is unchanged — the bodies below are Board's,
moved; only the surrounding parameters are new.

The original notes, preserved because they are the reason every line here exists:

  FNXC:WorkflowBoard 2026-07-05-14:20:
  Invariant: every rendered task must resolve to its REAL workflow, or the board
  silently drops it. A task created into a workflow whose intake column differs from
  the default (e.g. Coding (Ideas) -> "ideas", per FN-7591) disappears until the next
  mount/focus/workflow-CRUD refetch. Cause: the task list (SSE) updates before the
  board-workflows `taskWorkflowIds` map, so the effective workflow falls back to
  `defaultWorkflowId`, whose columns do not declare the intake column. Fix at the
  invariant, not the create surface: whenever a rendered task is absent from
  `taskWorkflowIds`, force ONE board-workflows refetch so its persisted workflow
  selection (and intake column) resolves. Signature-guarded on the sorted unmapped-id
  set so we never spin an infinite refetch loop, and only run once the payload loaded.

  The refetch is deferred by one macrotask and re-checked against the latest state at
  fire time: a surface's own quick-create commits the new task one microtask before the
  optimistic workflow seed lands, so a synchronous refetch would double-fire alongside
  the optimistic path. Deferring lets the seed land first.

  FNXC:WorkflowBoard 2026-07-12-23:40:
  The FN-7591 refetch must also fire for a PRESENT-but-unrepresentable mapping, not
  only an absent one. The server emits a `taskWorkflowIds` entry for every task
  (defaulting to the default workflow), so a stale selection row makes e.g. an
  "ideas"-column card map to plain Coding — an entry that exists but whose workflow
  does not declare the task's column. The `=== undefined` guard alone never re-fired
  for those, leaving the card permanently invisible in the aggregate view. A mapping is
  "suspect" when the resolved workflow's column set does not contain the task's stored
  column. The signature guard still prevents refetch loops for mappings that stay wrong
  after a fresh fetch.
*/
/** Attempts allowed per unresolved signature before the repair gives up. Two covers
 *  the fetch-races-the-selection-write case without permitting a refetch loop. */
const MAX_ATTEMPTS_PER_SIGNATURE = 2;

/** Delay before a follow-up attempt. An immediately-retried transient failure just
 *  fails again and burns the budget. */
const RETRY_DELAY_MS = 250;

export function useUnmappedWorkflowRefetch(params: {
  boardWorkflows: BoardWorkflowsPayload | null;
  tasks: readonly Task[];
  workflowMode: boolean;
  refreshBoardWorkflows: (options?: { forceFresh?: boolean; taskIds?: readonly string[] }) => void | Promise<void>;
  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  The project this repair belongs to. A repair pending across a PROJECT SWITCH would
  otherwise resume through the OLD project's `refreshBoardWorkflows` closure, and that
  stale request can claim the newest shared fetch sequence number — discarding the
  CURRENT project's response and leaving the view without workflow metadata. Every
  continuation checks this before doing anything.
  */
  projectId?: string;
}): void {
  const { boardWorkflows, tasks, workflowMode, refreshBoardWorkflows, projectId } = params;
  const projectIdRef = useRef(projectId);

  const boardWorkflowsRef = useRef(boardWorkflows);
  boardWorkflowsRef.current = boardWorkflows;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const lastUnmappedTaskSignatureRef = useRef<string | null>(null);
  const signatureAttemptsRef = useRef(0);
  const unmappedRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True from firing a forced refresh until it settles. The timer ref is already
   *  cleared by then, so without this the effect re-arms mid-flight. */
  const repairInFlightRef = useRef(false);
  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — CodeRabbit):
  MOUNTED LATCH. The unmount cleanup can only clear the timer that EXISTS at unmount. A
  forced refresh still in flight settles afterwards, its continuation passes the project
  check (the ref is unchanged by unmounting), and it schedules a timer nobody will ever
  clear — which then fires a refresh for a dead view. Both continuations check this.
  */
  const mountedRef = useRef(true);

  /*
  Abandon anything in flight when the project changes: cancel the pending timer, drop
  the in-flight latch, and reset the signature so the new project starts clean rather
  than inheriting the previous board's attempt budget.
  */
  useEffect(() => {
    projectIdRef.current = projectId;
    if (unmappedRefetchTimerRef.current) {
      clearTimeout(unmappedRefetchTimerRef.current);
      unmappedRefetchTimerRef.current = null;
    }
    repairInFlightRef.current = false;
    lastUnmappedTaskSignatureRef.current = null;
    signatureAttemptsRef.current = 0;
  }, [projectId]);

  const isTaskWorkflowMappingSuspect = useCallback((
    payload: NonNullable<typeof boardWorkflows>,
    task: Task,
  ): boolean => {
    const assigned = payload.taskWorkflowIds[task.id];
    if (assigned === undefined) return true;
    const known = payload.workflows.some((workflow) => workflow.id === assigned);
    const workflowId = known ? assigned : payload.defaultWorkflowId;
    const workflow = payload.workflows.find((candidate) => candidate.id === workflowId);
    return workflow !== undefined && !workflow.columns.some((column) => column.id === task.column);
  }, []);

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile, second round):
  SELF-DRIVING, not effect-driven. The retry budget alone was not enough: if the forced
  fetch REJECTS, `refreshBoardWorkflows` swallows the rejection by design (a transient
  failure is not authoritative), so `boardWorkflows` never changes, the effect's deps
  never change, and the effect never re-runs to spend the remaining attempt. The repair
  died on exactly the failure it exists to survive.

  So the repair re-arms itself from its own timer and re-reads live state through refs,
  independent of React re-rendering. It stops on any of: state no longer suspect, budget
  exhausted, or payload gone.

  Subsequent attempts wait RETRY_DELAY_MS rather than firing on the next macrotask — a
  transient network failure retried immediately just fails again and burns the budget.
  The FIRST attempt keeps its 0ms defer, which exists so an optimistic workflow seed can
  land before we decide anything.
  */
  const attemptRepair = useCallback((delayMs: number) => {
    if (unmappedRefetchTimerRef.current) clearTimeout(unmappedRefetchTimerRef.current);
    const armedForProject = projectIdRef.current;
    unmappedRefetchTimerRef.current = setTimeout(() => {
      unmappedRefetchTimerRef.current = null;
      if (!mountedRef.current) return;
      // The board moved on: this repair belongs to a project no longer shown.
      if (projectIdRef.current !== armedForProject) return;
      const latestWorkflows = boardWorkflowsRef.current;
      if (!latestWorkflows) return;
      const stillUnmappedTaskIds = tasksRef.current
        .filter((task) => isTaskWorkflowMappingSuspect(latestWorkflows, task))
        .map((task) => task.id);
      if (stillUnmappedTaskIds.length === 0) return;
      if (signatureAttemptsRef.current >= MAX_ATTEMPTS_PER_SIGNATURE) return;
      signatureAttemptsRef.current += 1;
      /*
      FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
      Re-arm only once this attempt has SETTLED. A fixed timer alone meant a request in
      flight for longer than RETRY_DELAY_MS had its successor started before its own
      answer arrived, so both attempts could be spent on the same unresolved state and
      the budget was gone before either response landed. `refreshBoardWorkflows` never
      rejects (a failed fetch is non-authoritative), so `finally` is the settle point
      for both outcomes; a non-promise return degrades to the old immediate re-arm.
      */
      repairInFlightRef.current = true;
      const settled = refreshBoardWorkflows({ forceFresh: true, taskIds: stillUnmappedTaskIds });
      if (settled && typeof (settled as Promise<void>).finally === "function") {
        void (settled as Promise<void>).finally(() => {
          repairInFlightRef.current = false;
          // A request can outlive BOTH the mount and the project it was armed for.
          if (!mountedRef.current) return;
          if (projectIdRef.current !== armedForProject) return;
          attemptRepair(RETRY_DELAY_MS);
        });
      } else {
        repairInFlightRef.current = false;
        attemptRepair(RETRY_DELAY_MS);
      }
    }, delayMs);
  }, [isTaskWorkflowMappingSuspect, refreshBoardWorkflows]);

  useEffect(() => {
    if (!boardWorkflows || !workflowMode) return;
    const unmapped = tasks
      .filter((task) => isTaskWorkflowMappingSuspect(boardWorkflows, task))
      .map((task) => task.id)
      .sort();
    if (unmapped.length === 0) {
      lastUnmappedTaskSignatureRef.current = null;
      signatureAttemptsRef.current = 0;
      return;
    }
    const signature = unmapped.join(",");
    if (signature === lastUnmappedTaskSignatureRef.current) {
      if (signatureAttemptsRef.current >= MAX_ATTEMPTS_PER_SIGNATURE) return;
    } else {
      lastUnmappedTaskSignatureRef.current = signature;
      signatureAttemptsRef.current = 0;
    }
    /*
    Once the self-driving loop is armed it owns the cadence. Re-arming from the effect
    on every payload change would cancel the pending RETRY_DELAY_MS wait and fire
    immediately, collapsing the backoff and spending the budget faster than intended.

    The in-flight latch covers the other half: between firing a forced refresh and its
    settling, the TIMER ref is already null, so the timer check alone let a payload
    change start the next attempt while the previous request was still outstanding.
    */
    if (unmappedRefetchTimerRef.current || repairInFlightRef.current) return;
    attemptRepair(0);
  }, [attemptRepair, boardWorkflows, isTaskWorkflowMappingSuspect, tasks, workflowMode]);

  /*
  FNXC:WorkflowBoard 2026-07-29-00:00 (PR #2530 review — greptile):
  SET IT TRUE ON SETUP, not just false on teardown. React StrictMode replays effects as
  mount -> cleanup -> mount while PRESERVING refs, so a latch only ever cleared would be
  left `false` after the replay and every deferred continuation would exit at the guard —
  the repair silently disabled for the whole session, in production, which is the exact
  defect class this unit exists to remove. I introduced it while fixing one.
  */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (unmappedRefetchTimerRef.current) clearTimeout(unmappedRefetchTimerRef.current);
    };
  }, []);
}
