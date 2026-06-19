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

export function isUserAuthoredSource(sourceType: string | null | undefined): boolean {
  return typeof sourceType === "string" && USER_AUTHORED_SOURCE_TYPES.has(sourceType);
}

export function classifyReleaseTask(input: ReleaseTaskClassificationInput): ReleaseTaskClassification {
  const text = [input.title, input.description, input.promptText]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n");

  if (!text.trim()) {
    return { isReleaseClass: false, signals: [] };
  }

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
