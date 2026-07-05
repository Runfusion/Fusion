/*
FNXC:ReleaseAuthorizationGate 2026-06-15-02:41:
FN-6481 closes the FN-6469 policy gap: release-class triage specs must not auto-dispatch unless the task was created from a user-authored surface and its PROMPT.md carries an explicit user authorization marker.
Agents and automation can write PROMPT.md, so the marker is ignored for every non-user SourceType; unknown or future source values fail closed by being treated as non-user-authored.
*/

const USER_AUTHORED_SOURCE_TYPES = new Set(["dashboard_ui", "quick_chat", "chat_session", "cli"]);

export interface ReleaseTaskClassificationInput {
  title?: string;
  description?: string;
  promptText?: string;
}

export interface ReleaseTaskClassification {
  isReleaseClass: boolean;
  signals: string[];
}

export interface ReleaseAuthorizationGateInput extends ReleaseTaskClassificationInput {
  sourceType: string | null | undefined;
}

export interface ReleaseAuthorizationGateDecision extends ReleaseTaskClassification {
  action: "allow" | "block";
  reason: string;
}

interface ReleaseSignalPattern {
  label: string;
  pattern: RegExp;
}

const RELEASE_SIGNAL_PATTERNS: ReleaseSignalPattern[] = [
  { label: "pnpm release", pattern: /\bpnpm\s+release\b/i },
  { label: "scripts/release.mjs", pattern: /(?:^|[^\w.-])scripts\/release\.mjs\b/i },
  { label: "changeset publish", pattern: /\b(?:pnpm\s+)?changeset\s+publish\b/i },
  { label: "npm publish @runfusion/fusion", pattern: /\bnpm\s+publish\b[\s\S]{0,240}@runfusion\/fusion\b|@runfusion\/fusion\b[\s\S]{0,240}\bnpm\s+publish\b/i },
  { label: "pnpm publish @runfusion/fusion", pattern: /\bpnpm\s+publish\b[\s\S]{0,240}@runfusion\/fusion\b|@runfusion\/fusion\b[\s\S]{0,240}\bpnpm\s+publish\b/i },
  { label: "publish to npm", pattern: /\bpublish\b[\s\S]{0,160}\b(?:to|on)\s+npm\b|\bnpm\b[\s\S]{0,160}\bpublish\b/i },
  { label: "git tag v<semver>", pattern: /\b(?:git\s+)?tag\s+v\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?\b/i },
  { label: "version-bump release commit", pattern: /\b(?:version\s*bump|bump\s+version|release\s+commit|release\s+version)\b[\s\S]{0,120}\bv\d+\.\d+\.\d+\b|\bv\d+\.\d+\.\d+\b[\s\S]{0,120}\b(?:version\s*bump|bump\s+version|release\s+commit|release\s+version)\b/i },
];

/*
FNXC:ReleaseAuthorizationGate 2026-07-05-15:40:
FN-7560: classifyReleaseTask matched a bare mention of a release signal (e.g. `scripts/release.mjs`) even when it appeared inside a disclaimer clause that explicitly states the task does NOT release — "this task performs no release/publish (releases are owned by `scripts/release.mjs`)". AI-authored specs routinely append such disclaimers, so revert/undo/UI tasks (FN-7525, FN-7554, FN-7556) were false-flagged as release-class and parked in awaiting-release-authorization with no in-band exit (their non-user sources make the authorization marker inert). Strip negated release-disclaimer clauses before signal matching so a spec that disclaims releasing does not self-incriminate. Genuine release intent survives because "run pnpm release" / "publish @runfusion/fusion" lives in a non-negated clause and is evaluated normally.
*/
const RELEASE_NEGATION_PATTERNS: RegExp[] = [
  // "performs no release", "performs no package release/publish"
  /\bperforms?\s+no\s+(?:[\w-]+\s+){0,3}?(?:release|publish)/i,
  // "does not perform any package release", "will not publish", "doesn't release"
  /\b(?:does|do|did|will|would|shall|can|could|should)(?:\s+not|n['’]?t)\b\s+(?:[\w-]+\s+){0,4}?(?:release|publish)/i,
  // "no release/publish", "no package/actual release"
  /\bno\s+(?:[\w-]+\s+){0,2}?(?:release|publish)\b/i,
  // "releases are owned by scripts/release.mjs" — ownership disclaimer, not intent
  /\breleases?\s+are\s+owned\s+by\b/i,
  // "never release/publish"
  /\bnever\s+(?:[\w-]+\s+){0,3}?(?:release|publish)/i,
];

/**
 * FNXC:ReleaseAuthorizationGate 2026-07-05-15:40:
 * Split into clause-sized segments (sentence terminators and line breaks) and
 * drop any segment carrying a release-negation cue, keeping segments small so
 * removing one disclaimer clause never discards an adjacent genuine release
 * instruction. Returns the surviving text for signal matching.
 */
export function stripNegatedReleaseClauses(text: string): string {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((clause) => !RELEASE_NEGATION_PATTERNS.some((pattern) => pattern.test(clause)))
    .join("\n");
}

export function isUserAuthoredSource(sourceType: string | null | undefined): boolean {
  return typeof sourceType === "string" && USER_AUTHORED_SOURCE_TYPES.has(sourceType);
}

export function classifyReleaseTask(input: ReleaseTaskClassificationInput): ReleaseTaskClassification {
  const rawText = [input.title, input.description, input.promptText]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n");

  if (!rawText.trim()) {
    return { isReleaseClass: false, signals: [] };
  }

  // Evaluate signals only against clauses that are not release disclaimers, so a
  // spec that says "this task performs no release" is not flagged as one.
  const text = stripNegatedReleaseClauses(rawText);

  const signals: string[] = [];
  for (const { label, pattern } of RELEASE_SIGNAL_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(label);
    }
  }

  return { isReleaseClass: signals.length > 0, signals };
}

export function parseReleaseAuthorizationMarker(promptText: string): boolean {
  return /^\s*\*\*Release Authorized By User:\*\*\s*yes\s*$/im.test(promptText);
}

export function evaluateReleaseAuthorizationGate(input: ReleaseAuthorizationGateInput): ReleaseAuthorizationGateDecision {
  const classification = classifyReleaseTask(input);
  if (!classification.isReleaseClass) {
    return {
      action: "allow",
      ...classification,
      reason: "Task does not contain release/publish intent signals.",
    };
  }

  const userAuthored = isUserAuthoredSource(input.sourceType);
  const hasMarker = parseReleaseAuthorizationMarker(input.promptText ?? "");
  if (userAuthored && hasMarker) {
    return {
      action: "allow",
      ...classification,
      reason: "Release-class task was created from a user-authored source and includes an explicit user authorization marker.",
    };
  }

  const sourceLabel = input.sourceType ?? "unknown";
  return {
    action: "block",
    ...classification,
    reason: userAuthored
      ? `Release-class task from user-authored source '${sourceLabel}' is missing **Release Authorized By User:** yes.`
      : `Release-class task from non-user-authored source '${sourceLabel}' requires operator review; PROMPT.md markers are ignored for this source.`,
  };
}
