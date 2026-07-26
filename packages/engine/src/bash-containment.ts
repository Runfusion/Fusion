import { homedir } from "node:os";

/*
FNXC:BashContainment 2026-07-26-12:40:
Security incident follow-up: an agent's real escalation chain was
`bash("cat ~/.fusion/settings.json")` (agents run as the same OS user, so the
0600 file holding `daemonToken` is readable) → find its own pending approval
request → `curl` the approvals decision API to approve itself. Fixing the
decision route alone is insufficient while bash can read the token.

This module is a PRIVILEGE-ESCALATION FLOOR, not a permission preference:
it holds UNCONDITIONALLY at every permission preset including the default
`unrestricted`. Ordinary bash permission gating stays policy-driven (see
agent-action-gate.ts); this floor only denies the narrow set of commands
that let an agent escalate its OWN privileges:
  1. reads of the Fusion global config / daemon token (~/.fusion, any
     .fusion/settings.json spelling, FUSION_DAEMON_TOKEN / daemonToken refs),
  2. reads of common same-user credential stores (~/.ssh, ~/.aws, ~/.netrc,
     ~/.npmrc, ~/.config/gh, ~/.docker/config.json, ~/.gnupg, ~/.kube),
  3. self-directed calls to the approvals API (/api/approvals, fn_token=).

HONESTY / LIMITATIONS (do not oversell this): matching happens on a
normalized copy of the command STRING (quotes/backslashes stripped, $HOME and
the literal home directory folded to ~, lowercased). That defeats the trivial
bypasses (`cat ~/.fus''ion/settings.json`, `"$HOME"/.fusion`, absolute home
paths) but NOT determined indirection: base64-built paths, variable
concatenation (a=fus; b=ion; cat ~/.$a$b/...), glob spelling (~/.f*sion),
symlinks created first, python/node one-liners, or reading via a spawned
interpreter. String inspection of shell cannot be sound. This floor raises
the cost of the KNOWN escalation chain and creates an audit-visible denial;
real containment requires OS-level isolation (separate user / sandbox),
which is out of scope here. Deny messages are deliberately explicit so a
probing agent's attempts are visible in session logs.
*/

export interface BashContainmentVerdict {
  allowed: boolean;
  /** Stable rule id for logs/tests when denied. */
  rule?: string;
  /** Human-readable denial reason (safe to surface to the agent). */
  reason?: string;
}

interface ContainmentRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

/*
FNXC:BashContainment 2026-07-26-12:40:
Rules match the NORMALIZED command (see normalizeCommand). Home-anchored
patterns use `~/.<dir>` because normalization folds $HOME/${HOME}/absolute
home spellings to `~`. `/users/<name>/` and `/home/<name>/` cover OTHER
users' homes which normalization cannot fold.
*/
const RULES: readonly ContainmentRule[] = [
  {
    id: "fusion-global-dir",
    pattern: /(?:~|\/users\/[^/\s]+|\/home\/[^/\s]+)\/\.fusion\b/,
    reason: "access to the global Fusion directory (daemon token / global settings) is not permitted from agent sessions",
  },
  {
    id: "fusion-settings-file",
    pattern: /\.fusion\/settings\.json/,
    reason: "access to Fusion settings.json is not permitted from agent sessions",
  },
  {
    id: "fusion-daemon-token",
    pattern: /fusion_daemon_token|fusion_dashboard_token|daemontoken/,
    reason: "referencing the Fusion daemon token is not permitted from agent sessions",
  },
  {
    id: "credential-store",
    pattern: /(?:~|\/users\/[^/\s]+|\/home\/[^/\s]+)\/(?:\.ssh|\.aws|\.netrc|\.npmrc|\.gnupg|\.kube|\.config\/gh|\.docker\/config\.json)\b/,
    reason: "access to user credential stores is not permitted from agent sessions",
  },
  {
    id: "approvals-api",
    pattern: /\/api\/approvals|fn_token=/,
    reason: "calling the Fusion approvals API from a shell is not permitted from agent sessions (approvals are decided by the operator)",
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HOME_DIR = homedir();
const HOME_PATTERN = new RegExp(escapeRegExp(HOME_DIR), "gi");

/**
 * FNXC:BashContainment 2026-07-26-12:40:
 * Normalization defeats quote-splitting and $HOME spellings only. Keep this
 * pure and dependency-free so it is trivially unit-testable.
 */
export function normalizeBashCommandForContainment(command: string): string {
  let normalized = command.replace(/["'\\]/g, "");
  normalized = normalized.replace(/\$\{home\}/gi, "~").replace(/\$home\b/gi, "~");
  if (HOME_DIR && HOME_DIR !== "/") {
    normalized = normalized.replace(HOME_PATTERN, "~");
  }
  return normalized.toLowerCase();
}

/** Evaluate the unconditional containment floor for one bash command string. */
export function evaluateBashContainment(command: string): BashContainmentVerdict {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: true };
  }
  const normalized = normalizeBashCommandForContainment(command);
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return { allowed: false, rule: rule.id, reason: rule.reason };
    }
  }
  return { allowed: true };
}

/** Stable message shown to the agent on denial. */
export function buildBashContainmentDenialMessage(verdict: BashContainmentVerdict): string {
  return (
    `Command blocked by Fusion privilege-escalation containment (${verdict.rule ?? "containment"}): ` +
    `${verdict.reason ?? "not permitted"}. This boundary applies at every permission preset; ` +
    `do not attempt to work around it — ask the operator instead.`
  );
}
