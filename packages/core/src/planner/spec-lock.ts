import { createHash } from "node:crypto";

export const SPEC_LOCK_PARSER_VERSION = 1;

export type SpecLockSection = "mission" | "file-scope" | "steps" | "acceptance-criteria" | "non-goals" | "dependencies" | "lineage";
export type SpecParseReason = "mission-missing" | "mission-empty" | "mission-duplicate" | "section-missing" | "section-duplicate";
export type SpecParseStatus = "available" | "unavailable";

export interface CanonicalPlanSection {
  status: SpecParseStatus;
  reason?: SpecParseReason;
  canonical: string;
  hash?: string;
}

export interface CanonicalPlan {
  parserVersion: number;
  sections: Record<SpecLockSection, CanonicalPlanSection>;
  contentHash?: string;
  status: SpecParseStatus;
  reason?: SpecParseReason;
}

export interface CurrentPlanEvidence {
  version: number;
  sourceRevision: number;
  sourceHash: string;
  capturedAt: string;
  plan: CanonicalPlan;
}

/** Live task relations are structural plan inputs alongside the persisted PROMPT.md source. */
export interface PlanEvidenceBindings {
  dependencies?: readonly string[];
  missionId?: string;
  sliceId?: string;
  sourceParentTaskId?: string;
}

export interface SpecLock {
  version: number;
  acceptedAt: string;
  approvalFingerprint: string;
  currentPlanVersion: number;
  currentPlanHash: string;
  plan: CanonicalPlan;
  priorVersion?: number;
  diff?: SpecLockDiff;
}

export interface SpecLockDiff { changedSections: SpecLockSection[]; }

const sections: Array<{ key: SpecLockSection; headings: string[]; required: boolean }> = [
  { key: "mission", headings: ["mission"], required: true },
  { key: "file-scope", headings: ["file scope"], required: false },
  { key: "steps", headings: ["steps"], required: false },
  { key: "acceptance-criteria", headings: ["completion criteria", "acceptance criteria"], required: false },
  { key: "non-goals", headings: ["do not", "non-goals"], required: false },
  { key: "dependencies", headings: ["dependencies"], required: false },
  { key: "lineage", headings: ["mission lineage", "parent-child lineage"], required: false },
];

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
/*
FNXC:SpecLock 2026-08-10-16:34:
Mission prose is structurally hashed, not line-layout hashed. Collapse every whitespace run so a
cosmetic paragraph reflow cannot create a deterministic plan-deviation finding.
*/
const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();
const normalizeListItems = (value: string): string[] => value.split("\n")
  .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").replace(/[ \t]+/g, " ").trim())
  .filter(Boolean);
const normalizeList = (value: string): string => [...new Set(normalizeListItems(value))].sort().join("\n");
const normalizeOrderedList = (value: string): string => normalizeListItems(value).join("\n");
const normalizedSection = (key: SpecLockSection, value: string): string => {
  /*
  FNXC:SpecLock 2026-08-09-19:01:
  File Scope is a cross-platform boundary. Canonicalize path separators before set normalization so
  equivalent Windows and POSIX declarations neither invalidate approval nor hide real scope creep.
  */
  if (key === "file-scope") return normalizeList(value.replace(/\\/g, "/"));
  if (key === "dependencies" || key === "lineage" || key === "acceptance-criteria" || key === "non-goals") return normalizeList(value);
  if (key === "steps") return normalizeOrderedList(value);
  return normalizeText(value);
};

/**
 * FNXC:SpecLock 2026-08-09-07:06:
 * FN-8845 compares only a fixed structural contract. Mission prose is normalized as text and
 * hashed, never interpreted, so whitespace is cosmetic while a narrative rewrite is observable.
 */
export function canonicalizePlan(prompt: string, bindings?: PlanEvidenceBindings): CanonicalPlan {
  const normalized = prompt.replace(/\r\n?/g, "\n");
  const headings = [...normalized.matchAll(/^##\s+(.+?)\s*$/gmi)].map((match) => ({ name: match[1].trim().toLowerCase(), start: match.index!, end: match.index! + match[0].length }));
  const result = {} as Record<SpecLockSection, CanonicalPlanSection>;
  for (const definition of sections) {
    const matches = headings.filter((heading) => definition.headings.includes(heading.name));
    if (matches.length > 1) {
      result[definition.key] = { status: "unavailable", reason: definition.key === "mission" ? "mission-duplicate" : "section-duplicate", canonical: "" };
      continue;
    }
    if (matches.length === 0) {
      result[definition.key] = definition.required
        ? { status: "unavailable", reason: definition.key === "mission" ? "mission-missing" : "section-missing", canonical: "" }
        : { status: "available", canonical: "" };
      continue;
    }
    const heading = matches[0];
    const next = headings.find((candidate) => candidate.start > heading.start);
    const canonical = normalizedSection(definition.key, normalized.slice(heading.end, next?.start).replace(/^\n+|\n+$/g, ""));
    if (definition.required && !canonical) {
      result[definition.key] = { status: "unavailable", reason: definition.key === "mission" ? "mission-empty" : "section-missing", canonical: "" };
    } else {
      result[definition.key] = { status: "available", canonical, hash: hash(canonical) };
    }
  }
  /*
  FNXC:SpecLock 2026-08-09-21:01:
  Dependency and lineage writers can change the approved scope without rewriting PROMPT.md. Bind
  their durable task-row values into the same canonical sections, so invalidation has a comparable
  current-plan revision and cannot degrade into an inactive-but-clean lock.
  */
  applyLivePlanBindings(result, bindings);
  const unavailable = Object.values(result).find((section) => section.status === "unavailable");
  if (unavailable) return { parserVersion: SPEC_LOCK_PARSER_VERSION, sections: result, status: "unavailable", reason: unavailable.reason };
  const content = JSON.stringify(Object.fromEntries(Object.entries(result).map(([key, section]) => [key, section.hash])));
  return { parserVersion: SPEC_LOCK_PARSER_VERSION, sections: result, contentHash: hash(content), status: "available" };
}

export function diffSpecLocks(previous: CanonicalPlan, next: CanonicalPlan): SpecLockDiff {
  return { changedSections: sections.map(({ key }) => key).filter((key) => previous.sections[key].hash !== next.sections[key].hash || previous.sections[key].status !== next.sections[key].status) };
}

/**
 * FNXC:SpecLock 2026-08-09-19:19:
 * A retained lock is only active when the task still carries the exact approval fingerprint and
 * canonical current-plan hash it accepted. Keep this predicate shared by API and evaluator so an
 * inactive lock cannot be rendered as on-plan after a prompt rewrite or approval invalidation.
 */
export function isSpecLockActive(
  lock: SpecLock | undefined,
  currentPlan: CurrentPlanEvidence | undefined,
  approvedPlanFingerprint: string | undefined,
): lock is SpecLock {
  return lock !== undefined
    && currentPlan?.plan.contentHash === lock.currentPlanHash
    && approvedPlanFingerprint?.trim() === lock.approvalFingerprint;
}

function normalizedPlanEvidenceBindings(bindings: PlanEvidenceBindings | undefined): PlanEvidenceBindings {
  const dependencies = [...new Set((bindings?.dependencies ?? []).map((value) => value.trim()).filter(Boolean))].sort();
  return {
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(bindings?.missionId?.trim() ? { missionId: bindings.missionId.trim() } : {}),
    ...(bindings?.sliceId?.trim() ? { sliceId: bindings.sliceId.trim() } : {}),
    ...(bindings?.sourceParentTaskId?.trim() ? { sourceParentTaskId: bindings.sourceParentTaskId.trim() } : {}),
  };
}

function applyLivePlanBindings(
  sections: Record<SpecLockSection, CanonicalPlanSection>,
  bindings: PlanEvidenceBindings | undefined,
): void {
  const normalized = normalizedPlanEvidenceBindings(bindings);
  const dependencies = (normalized.dependencies ?? []).map((value) => `task-dependency:${value}`);
  const lineage = [
    normalized.missionId ? `mission:${normalized.missionId}` : undefined,
    normalized.sliceId ? `slice:${normalized.sliceId}` : undefined,
    normalized.sourceParentTaskId ? `parent-task:${normalized.sourceParentTaskId}` : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const [key, values] of [["dependencies", dependencies], ["lineage", lineage]] as const) {
    if (values.length === 0 || sections[key].status !== "available") continue;
    const canonical = normalizeList([sections[key].canonical, ...values].filter(Boolean).join("\n"));
    sections[key] = { status: "available", canonical, hash: hash(canonical) };
  }
}

export function createCurrentPlanEvidence(input: Omit<CurrentPlanEvidence, "plan" | "sourceHash"> & { prompt: string; bindings?: PlanEvidenceBindings }): CurrentPlanEvidence {
  const { prompt, bindings, ...evidence } = input;
  const normalizedBindings = normalizedPlanEvidenceBindings(bindings);
  return {
    ...evidence,
    /* Bindings are part of the authoritative source identity: same prompt plus a dependency edit is a new revision. */
    sourceHash: hash(JSON.stringify({ prompt, bindings: normalizedBindings })),
    plan: canonicalizePlan(prompt, normalizedBindings),
  };
}
