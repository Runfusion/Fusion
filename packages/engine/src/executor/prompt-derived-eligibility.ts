/**
 * FNXC:CodeOrganization 2026-08-03-07:45:
 * Prompt-derived no-commit / plan-only eligibility peeled from executor.ts.
 * Complements no-commit-eligibility.ts (getNoCommitEligibilityReason).
 */
import type { Task } from "@fusion/core";

export function parseReviewLevelFromPrompt(prompt: string): number {
  const reviewMatch = prompt.match(/##\s*Review Level[:\s]*(\d)/);
  return reviewMatch ? parseInt(reviewMatch[1], 10) : 0;
}

export function extractPromptSection(prompt: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escaped}\\s*:?\\s*$`, "i");
  const nextHeadingPattern = /^##\s+/;
  const lines = prompt.split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return "";

  const sectionLines: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (nextHeadingPattern.test(line.trim())) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n").trim();
}

export function extractPromptListEntries(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^`([^`]+)`.*$/, "$1").trim())
    .filter(Boolean);
}

function isFusionTaskArtifactScopeEntry(entry: string): boolean {
  const normalized = entry.trim().toLowerCase().replace(/^<rootdir>\//, "").replace(/^\.\//, "");
  return normalized.startsWith(".fusion/tasks/");
}

function isNoSourceScopeEntry(entry: string): boolean {
  const normalized = entry.toLowerCase();
  return (
    normalized.includes("no source") ||
    normalized.includes("no product-source") ||
    normalized.includes("no code") ||
    normalized.includes("no file mutations") ||
    normalized.includes("task document") ||
    normalized.includes("task documents") ||
    normalized.includes("task metadata") ||
    normalized.includes("task log") ||
    normalized.includes("agent log") ||
    normalized.includes("task artifacts") ||
    normalized.includes("read-only evidence") ||
    isFusionTaskArtifactScopeEntry(normalized)
  );
}

/*
FNXC:CodeOrganization 2026-08-03-12:15:
PR #3317 nit: the read-only/no-source branch and the final fallback both returned false;
keep a single fallback after positive source-path / extension checks.
*/
function hasSourceChangingScopeEntry(entry: string): boolean {
  const normalized = entry.toLowerCase();
  if (!normalized) return false;
  if (isFusionTaskArtifactScopeEntry(normalized)) return false;
  const sourcePathPattern = /(?:^|[\s`'"(])(?:packages|src|source|sources|app|apps|lib|libs|components|scripts|docs|\.github|config|test|tests|__tests__|\.changeset)\//m;
  if (sourcePathPattern.test(normalized)) return true;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|swift|kt|java|py|rs|go|rb|md|json|ya?ml|toml|css|scss|html)\b/.test(normalized)) return true;
  return false;
}

function promptDeclaresSourceFreeTaskArtifactContract(combinedText: string): boolean {
  const forbidsForceAddingFusionArtifacts = /(?:do not|don't|never|must not)\s+(?:force[- ]?add|git add -f)[^\n]*(?:\.fusion|gitignored)/.test(combinedText)
    || /(?:\.fusion|gitignored)[^\n]*(?:do not|don't|never|must not)\s+(?:force[- ]?add|git add -f)/.test(combinedText);
  const forbidsFabricatedCommits = /(?:do not|don't|never|must not)\s+(?:create|make|fabricate|manufacture)[^\n]*(?:empty|fabricated|zero[- ]diff)[^\n]*commits?/.test(combinedText)
    || /(?:empty|fabricated|zero[- ]diff)[^\n]*commits?[^\n]*(?:do not|don't|never|must not|forbidden)/.test(combinedText);
  const declaresOnlySourceFreeArtifacts = /(?:source[- ]free|gitignored)[^\n]*(?:task[- ]artifact|task artifact|\.fusion\/tasks|deliver(?:y|able)|artifact)/.test(combinedText)
    || /(?:only|limited to)[^\n]*(?:source[- ]free|gitignored)[^\n]*(?:task[- ]artifact|task artifact|\.fusion\/tasks)/.test(combinedText);
  return (forbidsForceAddingFusionArtifacts && forbidsFabricatedCommits) || declaresOnlySourceFreeArtifacts;
}

function promptScopeIsSourceFreeTaskArtifacts(promptScopeEntries: string[], declaredScope: string[]): boolean {
  if (promptScopeEntries.length === 0 || declaredScope.length === 0) return false;
  if (declaredScope.some(hasSourceChangingScopeEntry)) return false;
  return declaredScope.every((entry) => isFusionTaskArtifactScopeEntry(entry) || isNoSourceScopeEntry(entry));
}

function getTaskTextForNoCommitEligibility(task: Task, promptContent: string): string {
  const logText = (task.log ?? [])
    .map((entry) => `${entry.action ?? ""}\n${entry.outcome ?? ""}`)
    .join("\n");
  const sourceMetadata = task.sourceMetadata ? JSON.stringify(task.sourceMetadata) : "";
  return [task.title, task.description, promptContent, sourceMetadata, logText]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

export function evaluatePromptDerivedNoCommitEligibility(task: Task, promptContent: string): { eligible: boolean; reason?: string } {
  const combined = getTaskTextForNoCommitEligibility(task, promptContent).toLowerCase();
  const promptScopeEntries = extractPromptListEntries(extractPromptSection(promptContent, "File Scope"));
  const metadataScope = Array.isArray(task.sourceMetadata?.fileScope)
    ? task.sourceMetadata.fileScope.filter((entry): entry is string => typeof entry === "string")
    : [];
  const declaredScope = [...promptScopeEntries, ...metadataScope];
  const stepsComplete = Array.isArray(task.steps) && task.steps.length > 0
    ? task.steps.every((step) => step.status === "done" || step.status === "skipped")
    : false;

  /*
  FNXC:TaskDoneCompletion 2026-07-03-00:00:
  Source-free deliveries that only write gitignored `.fusion/tasks/...` task artifacts must not fabricate empty commits or force-add ignored evidence just to satisfy fn_task_done. This exemption is intentionally narrower than Review Level 0/1: the PROMPT must declare a source-free task-artifact contract, every declared scope entry must be board/task artifact only, and any tracked source/docs/config/test/changeset path keeps the no_commits refusal intact.
  */
  if (
    stepsComplete &&
    promptDeclaresSourceFreeTaskArtifactContract(combined) &&
    promptScopeIsSourceFreeTaskArtifacts(promptScopeEntries, declaredScope)
  ) {
    return { eligible: true, reason: "prompt-derived source-free task-artifact contract" };
  }

  /*
  FNXC:ReviewLevelPreset 2026-07-19-10:35 (U8 / R6):
  reviewLevel is a CREATION-TIME preset (it writes enabledWorkflowSteps at create),
  so the runtime no longer reads `task.reviewLevel`. The plan-only (level-1)
  eligibility signal here is derived from the PROMPT contract, not the row field —
  removing the last `task.reviewLevel` runtime read (R6 tombstone). The explicit
  preset-set field re-key lands with U9's schema (reviewLevel backfill + field adds).
  */
  const reviewLevel = parseReviewLevelFromPrompt(promptContent);
  const isPlanOnly = reviewLevel === 1 && (/plan\s*only/.test(combined) || combined.includes("plan-only"));
  if (!isPlanOnly) return { eligible: false };

  const explicitNoSourceIntent = [
    "no expected product-source changes",
    "no product-source changes",
    "no source changes expected",
    "no source files expected",
    "no code changes expected",
    "no expected source changes",
    "no file mutations",
    "no source/config/file mutations",
  ].some((phrase) => combined.includes(phrase));
  if (!explicitNoSourceIntent) return { eligible: false };

  const excludedImplementationIntent = /\b(investigate and fix|fix if needed|implement|source-changing|code change|docs\/tests changes|documentation change|bug[- ]fix|feature)\b/.test(combined);
  const operationalIntent = /\b(operational|routing|route|assign|assignment|owner|handoff|coordination|coordinate|no-route|triage)\b/.test(combined);
  if (!operationalIntent || excludedImplementationIntent) return { eligible: false };

  if (declaredScope.length === 0) return { eligible: false };
  if (declaredScope.some(hasSourceChangingScopeEntry)) return { eligible: false };
  if (!declaredScope.every(isNoSourceScopeEntry)) return { eligible: false };

  const logText = (task.log ?? [])
    .map((entry) => `${entry.action ?? ""}\n${entry.outcome ?? ""}`)
    .join("\n")
    .toLowerCase();
  const hasOperationalEvidence = /\b(evidence|recorded|documented|no-route|routed|assigned|handoff|decision)\b/.test(logText);
  if (!stepsComplete && !hasOperationalEvidence) return { eligible: false };

  return { eligible: true, reason: "prompt/source metadata derived operational no-commit contract" };
}
