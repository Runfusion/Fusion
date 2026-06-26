/**
 * Task comments / activity-log / prompt-section rewriting helpers.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function bodies are byte-identical to their
 * pre-extraction form. The mutable activity-log limit state is encapsulated
 * here; store.ts re-imports the helpers and the test-only override seam.
 */
import type { TaskLogEntry } from "../types.js";
import { buildBootstrapPrompt } from "../mesh-task-replication.js";

const DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT = 1_000;
const DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT = 4_000;

let taskActivityLogEntryLimit = DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT;
let taskActivityLogOutcomeLimit = DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT;

export function getTaskActivityLogEntryLimit(): number {
  return taskActivityLogEntryLimit;
}

/**
 * Test-only seam for overriding task activity log retention/truncation limits.
 * Must not be used by production code. Tests overriding limits must restore
 * defaults in afterEach/afterAll by passing null.
 */
export function __setTaskActivityLogLimitsForTesting(
  overrides: { entryLimit?: number; outcomeLimit?: number } | null,
): void {
  if (overrides == null || (overrides.entryLimit == null && overrides.outcomeLimit == null)) {
    taskActivityLogEntryLimit = DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT;
    taskActivityLogOutcomeLimit = DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT;
    return;
  }

  if (overrides.entryLimit != null) {
    if (!Number.isInteger(overrides.entryLimit) || overrides.entryLimit < 1) {
      throw new Error("Task activity log entryLimit must be an integer >= 1");
    }
    taskActivityLogEntryLimit = overrides.entryLimit;
  }

  if (overrides.outcomeLimit != null) {
    if (!Number.isInteger(overrides.outcomeLimit) || overrides.outcomeLimit < 1) {
      throw new Error("Task activity log outcomeLimit must be an integer >= 1");
    }
    taskActivityLogOutcomeLimit = overrides.outcomeLimit;
  }
}

function truncateTaskLogOutcome(outcome: string | undefined): string | undefined {
  if (!outcome || outcome.length <= taskActivityLogOutcomeLimit) {
    return outcome;
  }
  return `${outcome.slice(0, taskActivityLogOutcomeLimit)}\n... outcome truncated to ${taskActivityLogOutcomeLimit} characters ...`;
}

export { truncateTaskLogOutcome };

export function compactTaskActivityLog(entries: TaskLogEntry[]): TaskLogEntry[] {
  const recentEntries = entries.slice(-taskActivityLogEntryLimit);
  return recentEntries.map((entry) => ({
    ...entry,
    outcome: truncateTaskLogOutcome(entry.outcome),
  }));
}

/**
 * Detect whether a PROMPT.md body is the auto-generated bootstrap stub
 * (`# heading\n\n<description>\n`) that `createTask` writes for triage tasks,
 * versus a real specification produced by triage or planning.
 *
 * Detection is wrapper-shape-exact: the on-disk content is compared against
 * the exact bytes `createTask` would have written for the *pre-update*
 * title/description. Earlier heuristic detectors (size caps, `##` header
 * presence, `**Created:**` / `**Size:**` markers) misfired on imported issue
 * bodies that contain `## Repro`, `**Created:** ...`, etc. — those are real
 * stubs but look like real specs to a content-inspecting check. By matching
 * against the wrapper produced from the previous title/description, we are
 * robust to anything the description itself contains.
 */
export function isBootstrapPromptStub(
  content: string,
  taskId: string,
  preUpdateTitle: string | undefined,
  preUpdateDescription: string,
): boolean {
  return content === buildBootstrapPrompt(taskId, preUpdateTitle, preUpdateDescription);
}

/**
 * Replace just the leading `# ...` heading line of a PROMPT.md body, leaving
 * every other section untouched. Used when a metadata edit (title or
 * description change) needs to keep the displayed heading in sync without
 * disturbing the rest of a real specification.
 *
 * If the file does not start with a `#` heading, it is returned verbatim —
 * the caller has no clean place to splice the heading and the spec's content
 * is more important to preserve than the displayed title (task.json is the
 * canonical source for title/description anyway).
 */
export function rewriteHeadingLine(content: string, newHeading: string): string {
  const match = content.match(/^#[^\n]*\n?/);
  if (!match) {
    return content;
  }
  const trailingNewline = match[0].endsWith("\n") ? "\n" : "";
  return `# ${newHeading}${trailingNewline}${content.slice(match[0].length)}`;
}

/**
 * Replace the body of the `## Mission` section with `newDescription`, leaving
 * every other section untouched. Used to propagate `task.description` edits
 * into a real spec without disturbing custom sections (Review Level, Frontend
 * UX Criteria, File Scope, Acceptance Criteria, etc.) that a section-whitelist
 * regen would silently drop.
 *
 * Returns the original content unchanged if there is no `## Mission` section.
 */
export function rewriteMissionSection(content: string, newDescription: string): string {
  const missionMatch = content.match(/^##\s+Mission\s*$/m);
  if (!missionMatch || missionMatch.index === undefined) {
    return content;
  }
  const headerEnd = missionMatch.index + missionMatch[0].length;
  const rest = content.slice(headerEnd);
  // Find the next `## ` heading (start of next section). The match position is
  // relative to `rest`, so we re-anchor to the absolute offset.
  const nextHeading = rest.search(/\n##\s/);
  const sectionEndAbsolute = nextHeading === -1 ? content.length : headerEnd + nextHeading;
  const before = content.slice(0, headerEnd);
  const after = content.slice(sectionEndAbsolute);
  // Reconstruct: header line + blank line + new description + blank line +
  // trailing content (which begins with the newline before the next heading).
  return `${before}\n\n${newDescription}\n${after}`;
}
