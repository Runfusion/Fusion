import type {
  Task,
  TaskCreateInput,
  TaskPriority,
  TaskStore,
  TraitDefinition,
} from "@fusion/core";
import {
  getTraitRegistry,
  registerTraitHookImpl,
  type PromptOverrideMap,
} from "@fusion/core";
import { createSessionDiagnostics } from "./ai-session-diagnostics.js";
import { decomposeForTriage, type SubtaskItem } from "./subtask-breakdown.js";

/**
 * U12 — Triage stage (auto-classify + decompose, for issues AND pull requests).
 *
 * Triage is expressed as a Trait with an `onEnter` hook (KTD7 / R8 / R14), NOT a
 * hardcoded executor branch. A column carrying the `triage` trait runs a
 * classify + decompose pass when a card enters it:
 *
 *   - Signals / issues:  classified (priority / area / labels), then decomposed
 *     into N `todo` child tasks linked back to the originating signal task. A
 *     signal too small to decompose passes through as a single task (routed to
 *     `todo`), never zero.
 *
 *   - Inbound pull requests (external contributors, dependabot, …): classified
 *     (dependency-bump vs feature) and either routed for review (labeled, moved
 *     to the review/`in-review` column) or used to open a follow-up `todo` task
 *     linked to the PR entity. PR triage reuses the existing `pull_requests` /
 *     PR-entity model — it never mints issues for PRs.
 *
 *   - Self-loop guard: a PR Fusion itself opened (an inbound==false PR, or one
 *     already owned by a non-terminal Fusion `PrEntity` for a task source) is
 *     NOT re-triaged.
 *
 *   - Classifier failure parks the item in triage with a diagnostic — it is
 *     never dropped.
 *
 * The trait DEFINITION lives in core's vocabulary-free registry slot (registered
 * here as a `builtin: true` def so plugins cannot override it). The IMPLEMENTATION
 * lives in dashboard because it reuses `subtask-breakdown` (engine agents) — wired
 * through the core→engine DI seam (`registerTraitHookImpl`), exactly like the
 * default-workflow hooks. Core stays engine-free.
 */

const diagnostics = createSessionDiagnostics("triage-trait");

/** Registry id of the triage trait. */
export const TRIAGE_TRAIT_ID = "triage";

/** Column a triaged item is routed TO once decomposed/classified. */
export const TRIAGE_DEFAULT_ROUTE_COLUMN = "todo";
/** Column an inbound PR routed for review lands in. */
export const TRIAGE_REVIEW_COLUMN = "in-review";

/** Metadata key marking a task as a triage product (a decomposed child). */
const TRIAGE_PARENT_META_KEY = "triageParentTaskId";
/** Metadata key recording that a task has been triaged (idempotency). */
const TRIAGE_DONE_META_KEY = "triageProcessedAt";
/** Metadata key on a PR-origin task carrying its PR entity id. */
const TRIAGE_PR_ENTITY_META_KEY = "prEntityId";

/**
 * The triage trait definition. Registered as a built-in (so a plugin cannot
 * override the id) but intentionally NOT part of the 14-entry vocabulary table —
 * it is a behavior trait shipped by U12, resolved through the same registry.
 */
export const TRIAGE_TRAIT_DEFINITION: TraitDefinition = {
  id: TRIAGE_TRAIT_ID,
  name: "Triage",
  description:
    "Auto-classify and decompose incoming signals/issues and inbound pull requests, then route to the board.",
  builtin: true,
  flags: { intake: true },
  hooks: { onEnter: true },
  configSchema: {
    fields: [
      { key: "routeColumn", type: "string", description: "Column to route triaged items to (default 'todo')" },
      { key: "reviewColumn", type: "string", description: "Column inbound PRs routed for review land in" },
      { key: "maxSubtasks", type: "number", description: "Cap on decomposed child tasks" },
    ],
  },
};

// ── Classification (pure, deterministic) ────────────────────────────────────

export type TriageItemKind = "signal" | "issue" | "pull_request";

export interface TriageClassification {
  priority: TaskPriority;
  /** Coarse area bucket inferred from the title/body. */
  area: "bug" | "feature" | "dependency" | "docs" | "infra" | "chore" | "unknown";
  /** Suggested labels (deduped). */
  labels: string[];
  /** PR-only: a dependency bump (dependabot / renovate / `bump`). */
  dependencyBump: boolean;
}

const DEP_BUMP_RE = /\b(bump|dependabot|renovate|update .* from .* to|upgrade dependenc)/i;
const BUG_RE = /\b(bug|error|crash|exception|fix|regress|fail|incident|outage|broken)\b/i;
const DOCS_RE = /\b(docs?|documentation|readme|typo)\b/i;
const INFRA_RE = /\b(ci|pipeline|deploy|infra|docker|k8s|kubernetes|build)\b/i;
const FEATURE_RE = /\b(feature|add|implement|support|enhanc)\b/i;

function inferPriority(severity: unknown, text: string): TaskPriority {
  const sev = typeof severity === "string" ? severity.toLowerCase() : "";
  if (sev === "critical") return "urgent";
  if (sev === "error") return "high";
  if (/\b(urgent|critical|sev-?1|p0)\b/i.test(text)) return "urgent";
  if (/\b(high|important|sev-?2|p1)\b/i.test(text)) return "high";
  if (sev === "warning") return "normal";
  return "normal";
}

/** Classify a triage item purely from its title/body + provenance. */
export function classifyTriageItem(params: {
  kind: TriageItemKind;
  title: string;
  body?: string;
  severity?: unknown;
  /** PR author login, when known (dependabot[bot], renovate[bot], …). */
  prAuthor?: string;
}): TriageClassification {
  const { kind, title, body, severity, prAuthor } = params;
  const text = `${title}\n${body ?? ""}`;
  const labels: string[] = [];

  const author = (prAuthor ?? "").toLowerCase();
  const dependencyBump =
    kind === "pull_request" &&
    (DEP_BUMP_RE.test(text) || author.includes("dependabot") || author.includes("renovate"));

  let area: TriageClassification["area"] = "unknown";
  if (dependencyBump) area = "dependency";
  else if (BUG_RE.test(text)) area = "bug";
  else if (DOCS_RE.test(text)) area = "docs";
  else if (INFRA_RE.test(text)) area = "infra";
  else if (FEATURE_RE.test(text)) area = "feature";
  else if (kind === "signal") area = "bug";

  if (area !== "unknown") labels.push(area);
  if (dependencyBump) labels.push("automated");
  if (kind === "signal") labels.push("signal");

  return {
    priority: inferPriority(severity, text),
    area,
    labels: [...new Set(labels)],
    dependencyBump,
  };
}

// ── PR-vs-issue + self-loop guard ───────────────────────────────────────────

/**
 * Decide what kind of triage item a task represents, and (for PRs) whether it is
 * an INBOUND PR (external contribution that warrants triage) or a Fusion-opened
 * PR (which must NOT be re-triaged — no self-loop).
 */
export interface TriageSubject {
  kind: TriageItemKind;
  /** True only for PRs that should be triaged (inbound external PRs). */
  triageable: boolean;
  /** Reason a PR was skipped (for diagnostics). */
  skipReason?: string;
  severity?: unknown;
  prAuthor?: string;
  prEntityId?: string;
}

/**
 * Classify the task's subject from its source provenance. A PR-origin task is
 * marked inbound only when its metadata says so AND no non-terminal Fusion
 * PrEntity already owns it (a Fusion-opened PR is owned by a `task`-sourced
 * entity → self-loop, skip).
 */
export async function resolveTriageSubject(task: Task, store?: TaskStore): Promise<TriageSubject> {
  const meta = (task.source?.sourceMetadata ?? {}) as Record<string, unknown>;
  const signalSource = meta.signalSource;
  const isPr =
    meta.triageItemKind === "pull_request" ||
    meta.resourceType === "pr" ||
    typeof meta.prNumber === "number" ||
    typeof meta[TRIAGE_PR_ENTITY_META_KEY] === "string";

  if (isPr) {
    const inboundFlag = meta.prInbound === true || meta.inbound === true;
    // Self-loop guard: a PR Fusion itself opened is owned by a non-terminal
    // PrEntity whose sourceType is "task" (the task that produced the branch).
    let fusionOwned = false;
    const prEntityId = typeof meta[TRIAGE_PR_ENTITY_META_KEY] === "string"
      ? (meta[TRIAGE_PR_ENTITY_META_KEY] as string)
      : undefined;
    if (store) {
      try {
        const entity = prEntityId
          ? await store.getPrEntity(prEntityId)
          : await store.getActivePrEntityBySource("task", task.id);
        if (entity && entity.sourceType === "task" && entity.state !== "closed" && entity.state !== "merged") {
          fusionOwned = true;
        }
      } catch {
        // Read failure → fall back to the inbound flag only.
      }
    }
    const triageable = inboundFlag && !fusionOwned;
    return {
      kind: "pull_request",
      triageable,
      skipReason: triageable
        ? undefined
        : fusionOwned
          ? "fusion-opened-pr (no self-loop)"
          : "not-marked-inbound",
      severity: meta.signalSeverity,
      prAuthor: typeof meta.prAuthor === "string" ? meta.prAuthor : undefined,
      prEntityId,
    };
  }

  return {
    kind: signalSource ? "signal" : "issue",
    triageable: true,
    severity: meta.signalSeverity,
  };
}

// ── Triage execution ────────────────────────────────────────────────────────

export interface TriageDeps {
  store: TaskStore;
  /** Working directory for the decomposition agent. */
  rootDir?: string;
  promptOverrides?: PromptOverrideMap;
  /** Override the decomposer (tests). Resolves to subtask items or throws. */
  decompose?: (description: string) => Promise<SubtaskItem[]>;
}

export type TriageOutcome =
  | { kind: "decomposed"; childTaskIds: string[]; routedColumn: string }
  | { kind: "passthrough"; taskId: string; routedColumn: string }
  | { kind: "pr-review"; taskId: string; routedColumn: string }
  | { kind: "pr-follow-up"; followUpTaskId: string; routedColumn: string }
  | { kind: "skipped"; reason: string }
  | { kind: "parked"; reason: string };

function alreadyTriaged(task: Task): boolean {
  const meta = (task.source?.sourceMetadata ?? {}) as Record<string, unknown>;
  return typeof meta[TRIAGE_DONE_META_KEY] === "string";
}

/** Mark the originating task as triaged + apply classification labels/priority.
 *  Metadata is merged via `sourceMetadataPatch` (the store's merge seam), not by
 *  rebuilding `source`. */
async function stampTriaged(
  store: TaskStore,
  task: Task,
  classification: TriageClassification,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await store.updateTask(task.id, {
    priority: classification.priority,
    sourceMetadataPatch: {
      [TRIAGE_DONE_META_KEY]: new Date().toISOString(),
      triageArea: classification.area,
      triageLabels: classification.labels,
      ...extra,
    },
  });
}

/**
 * Run the triage onEnter pass for a task. Idempotent: an already-triaged task is
 * a no-op skip. Routing/decomposition/PR handling per the plan's scenarios.
 */
export async function runTriageOnEnter(task: Task, deps: TriageDeps): Promise<TriageOutcome> {
  const { store } = deps;
  if (alreadyTriaged(task)) {
    return { kind: "skipped", reason: "already-triaged" };
  }

  const subject = await resolveTriageSubject(task, store);

  // ── PR path ───────────────────────────────────────────────────────────────
  if (subject.kind === "pull_request") {
    if (!subject.triageable) {
      // Self-loop / non-inbound PR: do not re-triage. Mark processed so a later
      // re-entry is a clean no-op, but take no decomposition action.
      try {
        await stampTriaged(
          store,
          task,
          classifyTriageItem({ kind: "pull_request", title: task.title ?? task.description, body: task.description }),
          { triageSkipped: subject.skipReason },
        );
      } catch (err) {
        diagnostics.errorFromException("Failed to stamp skipped PR", err, { taskId: task.id });
      }
      return { kind: "skipped", reason: subject.skipReason ?? "not-triageable" };
    }

    let classification: TriageClassification;
    try {
      classification = classifyTriageItem({
        kind: "pull_request",
        title: task.title ?? task.description,
        body: task.description,
        severity: subject.severity,
        prAuthor: subject.prAuthor,
      });
    } catch (err) {
      return parkInTriage(store, task, err, "pr-classify");
    }

    try {
      if (classification.dependencyBump) {
        // Dependency bumps are mechanical → route straight to review.
        await stampTriaged(store, task, classification, { triagePrRoute: "review" });
        await store.moveTask(task.id, TRIAGE_REVIEW_COLUMN);
        return { kind: "pr-review", taskId: task.id, routedColumn: TRIAGE_REVIEW_COLUMN };
      }
      // Feature/other inbound PR → open a follow-up review task linked to the PR
      // entity (we route the PR card to review and create the follow-up todo).
      await stampTriaged(store, task, classification, { triagePrRoute: "follow-up" });
      const followUp = await store.createTask(
        buildFollowUpTaskInput(task, classification, subject.prEntityId),
      );
      await store.moveTask(task.id, TRIAGE_REVIEW_COLUMN);
      return { kind: "pr-follow-up", followUpTaskId: followUp.id, routedColumn: TRIAGE_REVIEW_COLUMN };
    } catch (err) {
      return parkInTriage(store, task, err, "pr-route");
    }
  }

  // ── Signal / issue path ─────────────────────────────────────────────────────
  let classification: TriageClassification;
  try {
    classification = classifyTriageItem({
      kind: subject.kind,
      title: task.title ?? task.description,
      body: task.description,
      severity: subject.severity,
    });
  } catch (err) {
    return parkInTriage(store, task, err, "classify");
  }

  let subtasks: SubtaskItem[];
  try {
    const decompose = deps.decompose ?? ((d: string) => decomposeForTriage(d, deps.rootDir, deps.promptOverrides, deps.store));
    subtasks = await decompose(task.description);
  } catch (err) {
    return parkInTriage(store, task, err, "decompose");
  }

  const routeColumn = TRIAGE_DEFAULT_ROUTE_COLUMN;

  // Too small to decompose → pass through as a single task (NOT zero).
  if (subtasks.length <= 1) {
    try {
      await stampTriaged(store, task, classification, { triageDecomposed: false });
      await store.moveTask(task.id, routeColumn);
    } catch (err) {
      return parkInTriage(store, task, err, "passthrough");
    }
    return { kind: "passthrough", taskId: task.id, routedColumn: routeColumn };
  }

  // Decompose into N child todo tasks linked back to the signal.
  try {
    const childIds: string[] = [];
    for (const sub of subtasks) {
      const child = await store.createTask(
        buildChildTaskInput(task, sub, classification, routeColumn),
      );
      childIds.push(child.id);
    }
    await stampTriaged(store, task, classification, {
      triageDecomposed: true,
      triageChildTaskIds: childIds,
    });
    return { kind: "decomposed", childTaskIds: childIds, routedColumn: routeColumn };
  } catch (err) {
    return parkInTriage(store, task, err, "create-children");
  }
}

function buildChildTaskInput(
  parent: Task,
  sub: SubtaskItem,
  classification: TriageClassification,
  routeColumn: string,
): TaskCreateInput {
  const title = sub.title?.trim() || "Triaged subtask";
  const description = sub.description?.trim()
    ? `${title}\n\n${sub.description.trim()}`
    : `${title}\n\nDerived from triage of: ${parent.title ?? parent.id}`;
  return {
    title,
    description,
    column: routeColumn as TaskCreateInput["column"],
    priority: sub.priority ?? classification.priority,
    source: {
      sourceType: "automation",
      sourceParentTaskId: parent.id,
      sourceMetadata: {
        [TRIAGE_PARENT_META_KEY]: parent.id,
        triageArea: classification.area,
        triageLabels: classification.labels,
      },
    },
  };
}

function buildFollowUpTaskInput(
  prTask: Task,
  classification: TriageClassification,
  prEntityId?: string,
): TaskCreateInput {
  const title = `Review inbound PR: ${prTask.title ?? prTask.id}`;
  return {
    title,
    description: `${title}\n\nClassified as ${classification.area}. Follow-up to triaged inbound pull request.`,
    column: TRIAGE_DEFAULT_ROUTE_COLUMN as TaskCreateInput["column"],
    priority: classification.priority,
    source: {
      sourceType: "automation",
      sourceParentTaskId: prTask.id,
      sourceMetadata: {
        [TRIAGE_PARENT_META_KEY]: prTask.id,
        triageArea: classification.area,
        triageLabels: classification.labels,
        ...(prEntityId ? { [TRIAGE_PR_ENTITY_META_KEY]: prEntityId } : {}),
      },
    },
  };
}

/**
 * Classifier/decompose failure → PARK the item in triage with a diagnostic. The
 * task stays in `triage` (not dropped, not routed); a marker records the failure
 * so the surface can show it and a retry can re-run.
 */
async function parkInTriage(
  store: TaskStore,
  task: Task,
  err: unknown,
  phase: string,
): Promise<TriageOutcome> {
  const message = err instanceof Error ? err.message : String(err);
  diagnostics.errorFromException(`Triage ${phase} failed; parking in triage`, err, {
    taskId: task.id,
  });
  try {
    await store.updateTask(task.id, {
      sourceMetadataPatch: {
        triageError: message,
        triageErrorPhase: phase,
        triageErrorAt: new Date().toISOString(),
      },
    });
  } catch (writeErr) {
    diagnostics.errorFromException("Failed to record triage park marker", writeErr, {
      taskId: task.id,
    });
  }
  return { kind: "parked", reason: message };
}

// ── Registration (DI seam) ──────────────────────────────────────────────────

let registered = false;

/**
 * Register the triage trait definition + onEnter hook implementation into the
 * shared trait registry. Idempotent. The hook impl resolves `runTriageOnEnter`
 * against the provided store/deps factory — the engine-adjacent caller supplies
 * the live deps in the hook context (mirroring the default-workflow hook DI).
 */
export function registerTriageTrait(): void {
  if (registered) return;
  const registry = getTraitRegistry();
  if (!registry.has(TRIAGE_TRAIT_ID)) {
    registry.register(TRIAGE_TRAIT_DEFINITION);
  }
  registerTraitHookImpl(
    TRIAGE_TRAIT_ID,
    "onEnter",
    (...args: unknown[]) => {
      const ctx = args[0] as
        | { task?: Task; deps?: TriageDeps }
        | undefined;
      if (!ctx?.task || !ctx.deps) return undefined;
      return runTriageOnEnter(ctx.task, ctx.deps);
    },
  );
  registered = true;
}

/** Test-only: reset the registration latch. */
export function __resetTriageTraitForTests(): void {
  registered = false;
}
