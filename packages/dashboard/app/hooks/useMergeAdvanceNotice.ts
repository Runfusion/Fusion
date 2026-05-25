import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api } from "../api";
import { subscribeSse } from "../sse-bus";

export interface AutoSyncOutcome {
  worktreePath: string | null;
  outcome: string;
  mode: string;
  stashedFiles?: string[];
  untrackedRestored?: string[];
  untrackedSkippedAsTracked?: string[];
  conflictedFiles?: string[];
  patchPath?: string;
  stage?: string;
  error?: string;
}

interface MergeAdvanceEvent {
  taskId: string;
  integrationBranch: string;
  refName: string;
  toSha: string;
  fromSha: string | null;
  advanceMode: "fast-forward" | "non-fast-forward" | "update-ref" | string;
  succeeded: boolean;
  advancedAt: string;
  userCheckout: {
    worktreePath: string;
    dirty: boolean;
    untrackedCount: number;
  } | null;
  autoSync?: AutoSyncOutcome[];
}

interface MergeAdvanceEventsResponse {
  events: MergeAdvanceEvent[];
}

type SmartPullResponse =
  | { kind: "pull-clean"; toSha: string }
  | { kind: "pull-restored"; toSha: string }
  | { kind: "stash-conflict"; toSha: string; stashSha: string; stashLabel: string; conflictedFiles: string[]; autostashOutcome: "conflict-needs-manual" | "failed" };

type PushDisabledReason = "no-remote" | "no-upstream" | "not-ahead" | "merge-locked" | "not-a-git-repo";

export type PushOriginStatus = {
  integrationBranch: string;
  branchSource: "settings" | "origin-head" | "fallback";
  hasOriginRemote: boolean;
  hasUpstream: boolean;
  localSha: string | null;
  remoteSha: string | null;
  aheadCount: number;
  behindCount: number;
  mergeActive: boolean;
  canPush: boolean;
  disabledReason?: PushDisabledReason;
};

type PushResponse = {
  ok: boolean;
  outcome: "ok" | "rejected-non-ff" | "rejected-other" | "no-upstream" | "no-remote" | "merge-locked" | "not-ahead" | "sha-mismatch" | "failed";
  integrationBranch: string;
  aheadCount: number;
  localSha: string | null;
  remoteSha: string | null;
  forceWithLease: boolean;
  stderrPreview?: string;
  message?: string;
};

export type PushState = "idle" | "pending" | "ok" | {
  error: string;
  outcome: PushDisabledReason | "rejected-non-ff" | "rejected-other" | "sha-mismatch" | "failed";
  stderr?: string;
};

function dismissedStorageKey(projectId?: string): string {
  return `kb:merge-advance-notice-dismissed:${projectId ?? "default"}`;
}

function forceWithLeaseKey(projectId?: string): string {
  return `kb:${projectId ?? "default"}:merge-advance-force-with-lease`;
}

function readDismissedShas(projectId?: string): string[] {
  try {
    const raw = window.localStorage.getItem(dismissedStorageKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function persistDismissedShas(projectId: string | undefined, values: string[]): void {
  try {
    window.localStorage.setItem(dismissedStorageKey(projectId), JSON.stringify(values.slice(-50)));
  } catch {
    // ignore storage failures
  }
}

function readForceWithLease(projectId?: string): boolean {
  try {
    return window.sessionStorage.getItem(forceWithLeaseKey(projectId)) === "1";
  } catch {
    return false;
  }
}

function persistForceWithLease(projectId: string | undefined, enabled: boolean): void {
  try {
    window.sessionStorage.setItem(forceWithLeaseKey(projectId), enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

export function useMergeAdvanceNotice({ projectId, apiBase = "/api" }: { projectId?: string; apiBase?: string }) {
  const [events, setEvents] = useState<MergeAdvanceEvent[]>([]);
  const [dismissedShas, setDismissedShas] = useState<string[]>(() => readDismissedShas(projectId));
  const [pullState, setPullState] = useState<"idle" | "pending" | "stashing" | { error: string }>("idle");
  const [conflictState, setConflictState] = useState<{ stashSha: string; stashLabel: string; conflictedFiles: string[]; autostashOutcome: "conflict-needs-manual" | "failed" } | null>(null);
  const [pushStatus, setPushStatus] = useState<PushOriginStatus | null>(null);
  const [pushState, setPushState] = useState<PushState>("idle");
  const [forceWithLease, setForceWithLeaseState] = useState<boolean>(() => readForceWithLease(projectId));
  const pushOkTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setDismissedShas(readDismissedShas(projectId));
    setForceWithLeaseState(readForceWithLease(projectId));
  }, [projectId]);

  useEffect(() => () => {
    if (pushOkTimerRef.current !== null) {
      window.clearTimeout(pushOkTimerRef.current);
    }
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const query = new URLSearchParams({ limit: "5" });
      if (projectId) query.set("projectId", projectId);
      const response = await api<MergeAdvanceEventsResponse>(`/tasks/merge-advance-events?${query.toString()}`);
      setEvents(Array.isArray(response.events) ? response.events : []);
    } catch {
      setEvents([]);
    }
  }, [projectId]);

  const fetchPushStatus = useCallback(async () => {
    if (!projectId) {
      setPushStatus(null);
      return;
    }
    try {
      const status = await api<PushOriginStatus>(`/projects/${encodeURIComponent(projectId)}/merge-advance/push-status`);
      setPushStatus(status);
    } catch {
      setPushStatus(null);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchEvents();
    void fetchPushStatus();
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const unsubscribe = subscribeSse(`${apiBase}/events${query}`, {
      events: {
        "task:merged": () => {
          void fetchEvents();
          void fetchPushStatus();
        },
      },
    });
    return () => unsubscribe();
  }, [apiBase, fetchEvents, fetchPushStatus, projectId]);

  const notice = useMemo(() => {
    const dismissed = new Set(dismissedShas);
    return events.find((event) => {
      if (event.succeeded !== true) return false;
      if (event.userCheckout === null) return false;
      if (event.userCheckout.worktreePath.trim().length === 0) return false;
      if (dismissed.has(event.toSha)) return false;
      // Suppress the banner when the merger's auto-sync hook already brought
      // this user's checkout forward — `clean-sync` and
      // `synced-with-edits-restored` outcomes mean the worktree is already at
      // the new tip and there is nothing for the user to pull. Outcomes like
      // `synced-with-pop-conflict`, `skipped-dirty`, `skipped-*`, and
      // `failed` (or no auto-sync at all when the setting is `off`) leave
      // the worktree behind, so the banner must still surface.
      const userWorktreePath = event.userCheckout.worktreePath;
      const successOutcomes = new Set(["clean-sync", "synced-with-edits-restored"]);
      const handledByAutoSync = (event.autoSync ?? []).some((entry) =>
        entry.worktreePath === userWorktreePath && successOutcomes.has(entry.outcome),
      );
      if (handledByAutoSync) return false;
      return true;
    });
  }, [dismissedShas, events]);

  const dismiss = useCallback(() => {
    if (!notice) return;
    const next = [...dismissedShas.filter((sha) => sha !== notice.toSha), notice.toSha].slice(-50);
    setDismissedShas(next);
    persistDismissedShas(projectId, next);
  }, [dismissedShas, notice, projectId]);

  const pull = useCallback(async () => {
    if (!notice?.userCheckout) return;
    setPullState(notice.userCheckout.dirty || notice.userCheckout.untrackedCount > 0 ? "stashing" : "pending");
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const response = await api<SmartPullResponse>(`/git/pull${query}`, {
        method: "POST",
        body: JSON.stringify({ worktreePath: notice.userCheckout.worktreePath, integrationBranch: notice.integrationBranch, taskId: notice.taskId }),
      });
      if (response.kind === "stash-conflict") {
        setConflictState({
          stashSha: response.stashSha,
          stashLabel: response.stashLabel,
          conflictedFiles: response.conflictedFiles,
          autostashOutcome: response.autostashOutcome,
        });
      } else {
        dismiss();
      }
      setPullState("idle");
      await fetchPushStatus();
    } catch (error: unknown) {
      if (error instanceof ApiRequestError) {
        setPullState({ error: error.message || "Pull failed" });
      } else if (error instanceof Error && error.message) {
        setPullState({ error: error.message });
      } else {
        setPullState({ error: "Pull failed" });
      }
    }
  }, [dismiss, fetchPushStatus, notice, projectId]);

  const setForceWithLease = useCallback((enabled: boolean) => {
    setForceWithLeaseState(enabled);
    persistForceWithLease(projectId, enabled);
  }, [projectId]);

  const clearPushError = useCallback(() => {
    setPushState("idle");
  }, []);

  const push = useCallback(async () => {
    if (!projectId) return;
    setPushState("pending");
    try {
      const response = await api<PushResponse>(`/projects/${encodeURIComponent(projectId)}/merge-advance/push-origin`, {
        method: "POST",
        body: JSON.stringify({ forceWithLease, expectedLocalSha: pushStatus?.localSha }),
      });
      if (response.ok) {
        setPushState("ok");
        await fetchPushStatus();
        if (pushOkTimerRef.current !== null) window.clearTimeout(pushOkTimerRef.current);
        pushOkTimerRef.current = window.setTimeout(() => setPushState("idle"), 2000);
        return;
      }
      setPushState({
        error: response.message ?? response.outcome,
        outcome: response.outcome === "ok" ? "failed" : response.outcome,
        stderr: response.stderrPreview,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Push failed";
      setPushState({ error: message, outcome: "failed" });
    }
  }, [fetchPushStatus, forceWithLease, projectId, pushStatus?.localSha]);

  return {
    notice,
    dismiss,
    pull,
    pullState,
    conflictState,
    setConflictState,
    pushStatus,
    pushState,
    push,
    clearPushError,
    forceWithLease,
    setForceWithLease,
  };
}
