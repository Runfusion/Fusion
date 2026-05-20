import type { Task, TaskCreateInput, TaskStore } from "@fusion/core";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { runtimeLog } from "./logger.js";
import { createRunAuditor, generateSyntheticRunId, type RunAuditor } from "./run-audit.js";

const RECURRENCE_LOG_TAG = "[verification recurrence]";
const RECURRENCE_RATE_LIMIT_MS = 60 * 60 * 1000;
const SUPERSEDES_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOSED_COLUMNS = new Set(["done", "archived"]);

export type VerificationFailureSignatureInput = {
  lane: string;
  failingTestFiles: string[];
  failedCommand?: string | null;
};

export type AutomatedFollowupKind =
  | "verification-failure"
  | "merge-conflict"
  | "autostash-orphan"
  | "eval"
  | "pr-comment"
  | "scope-leak"
  | "contamination";

export type FollowupDedupDecision =
  | { action: "create-new"; supersedesTaskId?: string }
  | { action: "append-log"; existingTaskId: string; rateLimited: boolean };

export function computeVerificationFailureSignature(input: VerificationFailureSignatureInput): {
  signature: string;
  failingBasenames: string[];
  lane: string;
} {
  const lane = input.lane.trim();
  const failingBasenames = [...new Set(input.failingTestFiles.map((file) => basename(file.trim())).filter(Boolean))].sort();
  const signatureSource = failingBasenames.length > 0
    ? JSON.stringify({ lane, files: failingBasenames })
    : `${lane}|no-files`;
  const signature = createHash("sha256").update(signatureSource).digest("hex");
  return { signature, failingBasenames, lane };
}

export function extractFailingTestFiles(stdout: string, stderr: string): string[] {
  const text = `${stdout}\n${stderr}`;
  const files = new Set<string>();
  const patterns = [
    /^FAIL\s+(.+?)(?::\d+(?::\d+)?)?$/gm,
    /^[\u00D7\u2716]\s+(.+?)(?::\d+(?::\d+)?)?$/gm,
    /^Error in\s+(.+?)(?::\d+(?::\d+)?)?$/gm,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeMatchedPath(match[1]);
      if (candidate) files.add(candidate);
    }
  }

  return [...files].sort();
}

function normalizeMatchedPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const withoutDecorators = firstToken
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .replace(/^['"`]/, "")
    .replace(/['"`:,;]+$/, "");
  if (!withoutDecorators || !/[\\/]|\.[cm]?[jt]sx?$/.test(withoutDecorators)) {
    return null;
  }
  return basename(withoutDecorators);
}

function metadataMatches(
  task: Task,
  parentTaskId: string,
  extraMatchKeys: Record<string, string | number> | undefined,
): boolean {
  if (!extraMatchKeys || Object.keys(extraMatchKeys).length === 0) return false;
  if (task.sourceParentTaskId !== parentTaskId) return false;
  const metadata = task.sourceMetadata;
  if (!metadata) return false;
  return Object.entries(extraMatchKeys).every(([key, value]) => metadata[key] === value);
}

function getVerificationSignature(task: Task): string | undefined {
  const signature = task.sourceMetadata?.verificationFailureSignature;
  return typeof signature === "string" && signature.trim().length > 0 ? signature : undefined;
}

function buildDefaultAuditor(store: TaskStore, parentTaskId: string): RunAuditor {
  return createRunAuditor(store, {
    runId: generateSyntheticRunId("followup-dedup", parentTaskId),
    agentId: "automated-followup",
    taskId: parentTaskId,
    phase: "followup-dedup",
  });
}

async function computeRateLimited(store: TaskStore, taskId: string, now: number): Promise<boolean> {
  const fullTask = await store.getTask(taskId);
  for (let index = fullTask.log.length - 1; index >= 0; index -= 1) {
    const entry = fullTask.log[index];
    if (!entry?.action?.startsWith(RECURRENCE_LOG_TAG)) continue;
    const entryMs = Date.parse(entry.timestamp);
    if (Number.isNaN(entryMs)) return false;
    return entryMs > now - RECURRENCE_RATE_LIMIT_MS;
  }
  return false;
}

export async function decideAutomatedFollowup(
  store: TaskStore,
  params: {
    kind: AutomatedFollowupKind;
    parentTaskId: string;
    signature?: string;
    branch?: string | null;
    extraMatchKeys?: Record<string, string | number>;
    now?: number;
  },
): Promise<FollowupDedupDecision> {
  const now = params.now ?? Date.now();
  const tasks = await store.listTasks({ slim: true, includeArchived: true });
  const candidateTasks = tasks.filter((task) => task.id !== params.parentTaskId);
  const openTasks = candidateTasks.filter((task) => !CLOSED_COLUMNS.has(task.column));

  const signatureMatch = params.signature
    ? openTasks.find((task) => getVerificationSignature(task) === params.signature)
    : undefined;
  if (signatureMatch) {
    return {
      action: "append-log",
      existingTaskId: signatureMatch.id,
      rateLimited: await computeRateLimited(store, signatureMatch.id, now),
    };
  }

  const extraMatch = openTasks.find((task) => metadataMatches(task, params.parentTaskId, params.extraMatchKeys));
  if (extraMatch) {
    return {
      action: "append-log",
      existingTaskId: extraMatch.id,
      rateLimited: await computeRateLimited(store, extraMatch.id, now),
    };
  }

  const legacyParentMatch = openTasks.find(
    (task) => task.sourceType === "recovery" && task.sourceParentTaskId === params.parentTaskId,
  );
  if (legacyParentMatch) {
    return {
      action: "append-log",
      existingTaskId: legacyParentMatch.id,
      rateLimited: await computeRateLimited(store, legacyParentMatch.id, now),
    };
  }

  if (params.branch) {
    const branchMatch = openTasks.find((task) => task.branch === params.branch);
    if (branchMatch) {
      return {
        action: "append-log",
        existingTaskId: branchMatch.id,
        rateLimited: await computeRateLimited(store, branchMatch.id, now),
      };
    }
  }

  if (params.signature) {
    const recentClosedMatch = candidateTasks.find((task) => {
      if (!CLOSED_COLUMNS.has(task.column)) return false;
      if (getVerificationSignature(task) !== params.signature) return false;
      const closedMs = Date.parse(task.updatedAt || task.createdAt);
      return !Number.isNaN(closedMs) && closedMs > now - SUPERSEDES_WINDOW_MS;
    });
    if (recentClosedMatch) {
      return { action: "create-new", supersedesTaskId: recentClosedMatch.id };
    }
  }

  return { action: "create-new" };
}

export async function createAutomatedFollowup(
  store: TaskStore,
  params: {
    kind: AutomatedFollowupKind;
    parentTaskId: string;
    signature?: string;
    branch?: string | null;
    extraMatchKeys?: Record<string, string | number>;
    createInput: TaskCreateInput;
    auditor?: RunAuditor;
  },
): Promise<
  | { outcome: "deduped"; existingTaskId: string; rateLimited: boolean }
  | { outcome: "created"; task: Awaited<ReturnType<TaskStore["createTask"]>>; supersedesTaskId?: string }
> {
  const auditor = params.auditor ?? buildDefaultAuditor(store, params.parentTaskId);
  try {
    const decision = await decideAutomatedFollowup(store, {
      kind: params.kind,
      parentTaskId: params.parentTaskId,
      signature: params.signature,
      branch: params.branch,
      extraMatchKeys: params.extraMatchKeys,
    });

    if (decision.action === "append-log") {
      if (!decision.rateLimited) {
        await store.logEntry(
          decision.existingTaskId,
          `${RECURRENCE_LOG_TAG} signature=${params.signature ?? "none"}`,
          `kind=${params.kind}; parentTaskId=${params.parentTaskId}`,
        );
      }
      await auditor.database({
        type: "verification:followup-deduped",
        target: decision.existingTaskId,
        metadata: {
          kind: params.kind,
          parentTaskId: params.parentTaskId,
          existingTaskId: decision.existingTaskId,
          signature: params.signature,
          rateLimited: decision.rateLimited,
        },
      }).catch(() => undefined);
      return {
        outcome: "deduped",
        existingTaskId: decision.existingTaskId,
        rateLimited: decision.rateLimited,
      };
    }

    const source = params.createInput.source
      ? {
          ...params.createInput.source,
          sourceMetadata: {
            ...(params.createInput.source.sourceMetadata ?? {}),
            ...(params.signature ? { verificationFailureSignature: params.signature } : {}),
            ...(decision.supersedesTaskId ? { supersedesTaskId: decision.supersedesTaskId } : {}),
          },
        }
      : undefined;

    const task = await store.createTask({
      ...params.createInput,
      source,
    });

    await auditor.database({
      type: "verification:followup-created",
      target: task.id,
      metadata: {
        kind: params.kind,
        parentTaskId: params.parentTaskId,
        newTaskId: task.id,
        signature: params.signature,
        supersedesTaskId: decision.supersedesTaskId,
      },
    }).catch(() => undefined);

    return {
      outcome: "created",
      task,
      ...(decision.supersedesTaskId ? { supersedesTaskId: decision.supersedesTaskId } : {}),
    };
  } catch (error) {
    runtimeLog.warn(
      `Automated follow-up dedup failed open for ${params.parentTaskId} (${params.kind}): ${error instanceof Error ? error.message : String(error)}`,
    );
    const task = await store.createTask(params.createInput);
    return { outcome: "created", task };
  }
}

export const __testing__ = {
  normalizeMatchedPath,
  RECURRENCE_LOG_TAG,
  RECURRENCE_RATE_LIMIT_MS,
  SUPERSEDES_WINDOW_MS,
};
