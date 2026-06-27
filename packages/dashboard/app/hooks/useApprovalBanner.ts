/*
FNXC:ApprovalBanner 2026-06-24-00:00:
Approval-notification banner dedupe/dismiss state machine, driven by task:updated and approval:requested SSE events. Also fires the first-completed-task GitHub-star prompt. Extracted from AppInner.

FNXC:ApprovalBanner 2026-06-24-00:00:
Stale-closure / effect-identity hazard: the per-`tasks` ref-sync effect rebuilds the status + seen-key maps on every tasks change, and the dismissal-timestamp comparison (`updatedAtMs <= dismissedAt`) suppresses re-trigger. Preserve both exactly when touching this hook (see docs/solutions ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation and logic-errors/queued-chat-message-flush-trusts-stale-isgenerating).

FNXC:ApprovalBanner 2026-06-26-00:00:
The mailbox approval banner represents only real ApprovalRequest rows delivered by approval:requested SSE with approval:<id> dedupe keys. Task awaiting-approval is a plan-approval lifecycle state surfaced on the triage board and must not create an Open Mailbox banner or refresh mailbox counts.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import { subscribeSse } from "../sse-bus";
import {
  type ApprovalBannerCandidate,
  didEnterDone,
  loadApprovalBannerDismissals,
  parseDateMs,
  persistApprovalBannerDismissals,
} from "../utils/appLifecycle";

export interface UseApprovalBannerOptions {
  tasks: Task[];
  currentProjectId: string | undefined;
  gitHubStarPromptShown: boolean;
  /** Invoked when a task first transitions to done (drives the GitHub-star prompt). */
  onStarPrompt: () => void;
}

export interface UseApprovalBannerResult {
  candidate: ApprovalBannerCandidate | null;
  dismissApproval: (candidate: ApprovalBannerCandidate) => void;
}

export function useApprovalBanner({
  tasks,
  currentProjectId,
  gitHubStarPromptShown,
  onStarPrompt,
}: UseApprovalBannerOptions): UseApprovalBannerResult {
  const [candidate, setCandidate] = useState<ApprovalBannerCandidate | null>(null);
  const taskStatusByIdRef = useRef<Map<string, string | undefined>>(new Map());
  const seenApprovalKeysRef = useRef<Set<string>>(new Set());
  const approvalDismissalsRef = useRef<Map<string, number>>(loadApprovalBannerDismissals());

  useEffect(() => {
    const next = new Map<string, string | undefined>();
    const nextSeen = new Set<string>();
    for (const task of tasks) {
      next.set(task.id, task.status);
    }
    taskStatusByIdRef.current = next;
    seenApprovalKeysRef.current = nextSeen;
  }, [tasks]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (currentProjectId) {
      params.set("projectId", currentProjectId);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";

    const triggerApprovalBanner = (next: ApprovalBannerCandidate) => {
      const dismissedAt = approvalDismissalsRef.current.get(next.dedupeKey);
      if (dismissedAt !== undefined && next.updatedAtMs <= dismissedAt) {
        return;
      }
      setCandidate(next);
    };

    return subscribeSse(`/api/events${query}`, {
      events: {
        "approval:requested": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as {
              id?: string;
              taskId?: string;
              updatedAt?: string;
              createdAt?: string;
            };
            const dedupeKey = payload.id ? `approval:${payload.id}` : undefined;
            if (!dedupeKey || seenApprovalKeysRef.current.has(dedupeKey)) {
              return;
            }
            seenApprovalKeysRef.current.add(dedupeKey);
            triggerApprovalBanner({
              dedupeKey,
              updatedAtMs: parseDateMs(payload.updatedAt ?? payload.createdAt),
            });
          } catch {
            // no-op
          }
        },
        "task:updated": (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data) as { id?: string; status?: string; updatedAt?: string };
            if (!payload?.id) {
              return;
            }
            const previousStatus = taskStatusByIdRef.current.get(payload.id);
            taskStatusByIdRef.current.set(payload.id, payload.status);
            if (!gitHubStarPromptShown && didEnterDone(payload.status, previousStatus)) {
              onStarPrompt();
            }
          } catch {
            // no-op
          }
        },
      },
    });
  }, [currentProjectId, gitHubStarPromptShown, onStarPrompt]);

  const dismissApproval = useCallback((dismissed: ApprovalBannerCandidate) => {
    approvalDismissalsRef.current.set(
      dismissed.dedupeKey,
      Math.max(Date.now(), dismissed.updatedAtMs),
    );
    persistApprovalBannerDismissals(approvalDismissalsRef.current);
    setCandidate(null);
  }, []);

  return { candidate, dismissApproval };
}
