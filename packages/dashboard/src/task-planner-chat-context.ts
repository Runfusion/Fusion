import type { TaskStore } from "@fusion/core";

const DEFAULT_TASK_SPEC_MAX_CHARS = 3_000;
const DEFAULT_RECENT_ACTIVITY_LIMIT = 12;
const DEFAULT_RECENT_ACTIVITY_MAX_CHARS = 500;
const DEFAULT_RECENT_COMMENT_LIMIT = 8;
const DEFAULT_RECENT_COMMENT_MAX_CHARS = 500;
const DEFAULT_STEP_LIMIT = 20;
const DEFAULT_DEPENDENCY_LIMIT = 20;

type UnknownRecord = Record<string, unknown>;

interface TaskPlannerChatContextOptions {
  taskSpecMaxChars?: number;
  recentActivityLimit?: number;
  recentActivityMaxChars?: number;
  recentCommentLimit?: number;
  recentCommentMaxChars?: number;
  stepLimit?: number;
  dependencyLimit?: number;
}

export interface TaskPlannerChatDependencyContext {
  id: string;
  title?: string;
  column?: string;
  status?: string;
  missing?: boolean;
}

export interface TaskPlannerChatContextSnapshot {
  taskId: string;
  title?: string;
  description?: string;
  prompt?: string;
  plan?: string;
  column?: string;
  status?: string;
  progress?: string;
  currentStep?: string;
  priority?: string;
  assignedAgent?: string;
  dependencies: TaskPlannerChatDependencyContext[];
  steps: string[];
  recentComments: string[];
  recentActivity: string[];
  source: string[];
  review: string[];
  notes: string[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(record: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(record: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function summarizeList<T>(items: T[] | undefined, format: (item: T, index: number) => string | null, limit: number): string[] {
  const values = (items ?? []).map(format).filter((value): value is string => Boolean(value));
  const selected = values.slice(-limit);
  if (values.length > selected.length) {
    return [`…${values.length - selected.length} older entries omitted`, ...selected];
  }
  return selected;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function formatTimestampPrefix(record: UnknownRecord): string {
  const timestamp = readString(record, "timestamp", "createdAt", "updatedAt");
  return timestamp ? `[${timestamp}] ` : "";
}

function formatProgress(task: UnknownRecord): string | undefined {
  const explicitProgress = readString(task, "progress");
  if (explicitProgress) return explicitProgress;

  const currentStep = readNumber(task, "currentStep");
  const steps = Array.isArray(task.steps) ? task.steps : [];
  if (typeof currentStep === "number" && steps.length > 0) {
    return `step ${currentStep + 1} of ${steps.length}`;
  }

  const done = steps.filter((step) => isRecord(step) && readString(step, "status") === "done").length;
  if (steps.length > 0) {
    return `${done}/${steps.length} steps done`;
  }
  return undefined;
}

function formatCurrentStep(task: UnknownRecord): string | undefined {
  const currentStep = readNumber(task, "currentStep");
  const steps = Array.isArray(task.steps) ? task.steps : [];
  if (typeof currentStep !== "number" || currentStep < 0 || currentStep >= steps.length) {
    return undefined;
  }
  const step = steps[currentStep];
  if (!isRecord(step)) return `Step ${currentStep + 1}`;
  const title = readString(step, "title", "name") ?? `Step ${currentStep + 1}`;
  const status = readString(step, "status") ?? "unknown";
  return `${title}: ${status}`;
}

function collectSourceContext(task: UnknownRecord): string[] {
  const source: string[] = [];
  const sourceIssue = isRecord(task.sourceIssue) ? task.sourceIssue : undefined;
  if (sourceIssue) {
    const title = readString(sourceIssue, "title");
    const url = readString(sourceIssue, "url", "htmlUrl");
    const state = readString(sourceIssue, "state", "status");
    source.push(`Issue${title ? ` ${title}` : ""}${state ? ` (${state})` : ""}${url ? ` — ${url}` : ""}`);
  }
  const pr = isRecord(task.pr) ? task.pr : isRecord(task.prInfo) ? task.prInfo : undefined;
  if (pr) {
    const title = readString(pr, "title");
    const url = readString(pr, "url", "htmlUrl");
    const state = readString(pr, "state", "status");
    source.push(`PR${title ? ` ${title}` : ""}${state ? ` (${state})` : ""}${url ? ` — ${url}` : ""}`);
  }
  return source;
}

function collectReviewContext(task: UnknownRecord): string[] {
  const review: string[] = [];
  for (const key of ["reviewState", "reviewStatus", "mergeStatus", "prState"]) {
    const value = readString(task, key);
    if (value) review.push(`${key}: ${value}`);
  }
  return review;
}

function buildSnapshot(task: unknown, dependencies: TaskPlannerChatDependencyContext[], options: Required<TaskPlannerChatContextOptions>): TaskPlannerChatContextSnapshot {
  const record = isRecord(task) ? task : {};
  const taskId = readString(record, "id") ?? "unknown";
  const prompt = readString(record, "prompt");
  const plan = readString(record, "plan");
  const description = readString(record, "description");

  const steps = summarizeList(Array.isArray(record.steps) ? record.steps : [], (step, index) => {
    if (!isRecord(step)) return null;
    const title = readString(step, "title", "name") ?? `Step ${index + 1}`;
    const status = readString(step, "status") ?? "unknown";
    return `- ${title}: ${status}`;
  }, options.stepLimit);

  const recentComments = summarizeList([
    ...(Array.isArray(record.comments) ? record.comments : []),
    ...(Array.isArray(record.steeringComments) ? record.steeringComments : []),
  ], (comment) => {
    if (!isRecord(comment)) return null;
    const text = readString(comment, "text", "message", "content");
    if (!text) return null;
    const author = readString(comment, "author", "authorId", "from") ?? "user";
    return `- ${formatTimestampPrefix(comment)}${author}: ${truncate(text, options.recentCommentMaxChars)}`;
  }, options.recentCommentLimit);

  const activitySource = Array.isArray(record.activityLog)
    ? record.activityLog
    : Array.isArray(record.log)
      ? record.log
      : Array.isArray(record.agentLog)
        ? record.agentLog
        : [];
  const recentActivity = summarizeList(activitySource, (entry) => {
    if (!isRecord(entry)) return null;
    const message = readString(entry, "message", "text", "summary", "details", "outcome", "action");
    if (!message) return null;
    const level = readString(entry, "level", "type", "event", "agent") ?? "log";
    return `- ${formatTimestampPrefix(entry)}${level}: ${truncate(message, options.recentActivityMaxChars)}`;
  }, options.recentActivityLimit);

  return {
    taskId,
    title: readString(record, "title"),
    description,
    prompt,
    plan,
    column: readString(record, "column"),
    status: readString(record, "status"),
    progress: formatProgress(record),
    currentStep: formatCurrentStep(record),
    priority: readString(record, "priority"),
    assignedAgent: readString(record, "assignedAgent", "assignedAgentId", "agentId", "executorAgentId"),
    dependencies,
    steps,
    recentComments,
    recentActivity,
    source: collectSourceContext(record),
    review: collectReviewContext(record),
    notes: [
      prompt || plan || description ? "" : "Task prompt/plan content is not available in the current context.",
      recentActivity.length > 0 ? "" : "Recent activity/log context is not available.",
      dependencies.length > 0 ? "" : "No dependencies are listed for this task.",
    ].filter(Boolean),
  };
}

async function resolveDependencies(taskStore: TaskStore, task: unknown, options: Required<TaskPlannerChatContextOptions>): Promise<TaskPlannerChatDependencyContext[]> {
  const record = isRecord(task) ? task : {};
  const dependencyIds = uniqueStrings(record.dependencies).slice(0, options.dependencyLimit);
  const dependencies: TaskPlannerChatDependencyContext[] = [];
  for (const dependencyId of dependencyIds) {
    try {
      const dependency = await taskStore.getTask(dependencyId);
      const dependencyRecord = isRecord(dependency) ? dependency : {};
      dependencies.push({
        id: dependencyId,
        title: readString(dependencyRecord, "title"),
        column: readString(dependencyRecord, "column"),
        status: readString(dependencyRecord, "status"),
      });
    } catch {
      dependencies.push({ id: dependencyId, missing: true });
    }
  }
  return dependencies;
}

function optionsWithDefaults(options: TaskPlannerChatContextOptions = {}): Required<TaskPlannerChatContextOptions> {
  return {
    taskSpecMaxChars: options.taskSpecMaxChars ?? DEFAULT_TASK_SPEC_MAX_CHARS,
    recentActivityLimit: options.recentActivityLimit ?? DEFAULT_RECENT_ACTIVITY_LIMIT,
    recentActivityMaxChars: options.recentActivityMaxChars ?? DEFAULT_RECENT_ACTIVITY_MAX_CHARS,
    recentCommentLimit: options.recentCommentLimit ?? DEFAULT_RECENT_COMMENT_LIMIT,
    recentCommentMaxChars: options.recentCommentMaxChars ?? DEFAULT_RECENT_COMMENT_MAX_CHARS,
    stepLimit: options.stepLimit ?? DEFAULT_STEP_LIMIT,
    dependencyLimit: options.dependencyLimit ?? DEFAULT_DEPENDENCY_LIMIT,
  };
}

export function formatTaskPlannerChatContext(snapshot: TaskPlannerChatContextSnapshot, options: TaskPlannerChatContextOptions = {}): string {
  const resolvedOptions = optionsWithDefaults(options);
  const promptText = snapshot.prompt?.trim() ?? "";
  const planText = snapshot.plan?.trim() ?? "";
  const descriptionText = snapshot.description?.trim() ?? "";
  const primaryTaskSpec = promptText || planText || descriptionText;
  const primaryTaskSpecLabel = promptText ? "Prompt" : planText ? "Plan" : "Description";

  const parts = [
    `Task ID: ${snapshot.taskId}`,
    snapshot.title ? `Title: ${snapshot.title}` : "Title: not available",
    `Column: ${snapshot.column ?? "unknown"}`,
    `Status: ${snapshot.status ?? "unknown"}`,
    snapshot.progress ? `Progress: ${snapshot.progress}` : "Progress: not available",
    snapshot.currentStep ? `Current step: ${snapshot.currentStep}` : "Current step: not available",
    snapshot.priority ? `Priority: ${snapshot.priority}` : "Priority: not available",
    snapshot.assignedAgent ? `Assigned agent: ${snapshot.assignedAgent}` : "Assigned agent: not available",
  ];

  if (snapshot.dependencies.length > 0) {
    parts.push(`Dependencies:\n${snapshot.dependencies.map((dependency) => {
      if (dependency.missing) return `- ${dependency.id}: details unavailable`;
      const details = [dependency.title, dependency.column, dependency.status].filter(Boolean).join("; ");
      return `- ${dependency.id}${details ? `: ${details}` : ": details unavailable"}`;
    }).join("\n")}`);
  } else {
    parts.push("Dependencies: none");
  }

  parts.push(primaryTaskSpec ? `${primaryTaskSpecLabel}:\n${truncate(primaryTaskSpec, resolvedOptions.taskSpecMaxChars)}` : "Prompt/plan: not available");
  if (promptText && planText && planText !== promptText) {
    parts.push(`Plan:\n${truncate(planText, resolvedOptions.taskSpecMaxChars)}`);
  }
  parts.push(snapshot.steps.length > 0 ? `Steps:\n${snapshot.steps.join("\n")}` : "Steps: not available");
  parts.push(snapshot.recentActivity.length > 0 ? `Recent activity:\n${snapshot.recentActivity.join("\n")}` : "Recent activity: not available");
  parts.push(snapshot.recentComments.length > 0 ? `Recent comments / steering:\n${snapshot.recentComments.join("\n")}` : "Recent comments / steering: not available");
  if (snapshot.source.length > 0) parts.push(`Source / PR context:\n${snapshot.source.map((item) => `- ${item}`).join("\n")}`);
  if (snapshot.review.length > 0) parts.push(`Review / merge state:\n${snapshot.review.map((item) => `- ${item}`).join("\n")}`);
  if (snapshot.notes.length > 0) parts.push(`Context availability notes:\n${snapshot.notes.map((note) => `- ${note}`).join("\n")}`);
  return parts.join("\n\n");
}

export async function buildTaskPlannerChatContext(taskStore: TaskStore, taskId: string, options: TaskPlannerChatContextOptions = {}): Promise<{ snapshot: TaskPlannerChatContextSnapshot; promptContext: string }> {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new Error("taskId is required");
  }
  const resolvedOptions = optionsWithDefaults(options);
  const task = await taskStore.getTask(normalizedTaskId, { activityLogLimit: resolvedOptions.recentActivityLimit + 8 } as never);
  const dependencies = await resolveDependencies(taskStore, task, resolvedOptions);
  const snapshot = buildSnapshot(task, dependencies, resolvedOptions);
  const promptContext = formatTaskPlannerChatContext(snapshot, resolvedOptions);
  return { snapshot, promptContext };
}

/*
FNXC:TaskDetailPlannerChat 2026-06-30-23:58:
Task-detail planner Chat receives this server-built, bounded task snapshot so the planner can answer current status, progress, dependency, recent-activity, and prompt/plan questions without trusting client-supplied context. Activity remains the operational steering/execution transcript; this formatter exposes comments/log excerpts as read-only context and records unavailable sections explicitly so the planner states uncertainty instead of inventing fresh execution evidence.
*/
export const TASK_PLANNER_CHAT_CONTEXT_PROMPT_GUIDANCE = `## Task Planner Chat Context
You are answering in the task detail Chat tab for a single Fusion task. Use the bounded server-supplied context below to answer questions about current status, progress, dependencies, recent activity, source/review state, and the task prompt or plan. State uncertainty when a section is absent, stale, truncated, or marked unavailable. Do not claim you ran code, tests, builds, or inspected files unless the supplied context or explicit tool output says so. Keep Activity separate from Chat: Activity is the execution/steering transcript, while this Chat reply is a planner conversation. Do not mutate steering comments for ordinary status/progress questions.`;
