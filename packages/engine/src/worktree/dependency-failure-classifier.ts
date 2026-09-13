import { createHash } from "node:crypto";
import type { DependencyCommandResult } from "./worktree-dependency-install.js";

export const DEPENDENCY_WORKTREE_STATE_INDETERMINATE = "indeterminate";

/*
FNXC:WorktreeDependencies 2026-09-13-06:25:
Only a failure that cannot change without operator action may be deterministic because that
classification authorizes freezing a card. A repeat counts only when the worktree state is provably
unchanged, preserving the reported requirement that configuration or worktree changes get a fresh attempt.
*/
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?\/(?:[^\s:'"`]+\/)*[^\s:'"`]+/g;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const DURATION = /\b\d+(?:\.\d+)?(?:ms|s)\b/gi;
const HEX_ID = /\b[a-f0-9]{8,}\b/gi;

export function normalizeDependencyDiagnostic(details: string): string {
  const lines = details
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(ABSOLUTE_PATH, "<path>")
      .replace(TIMESTAMP, "<timestamp>")
      .replace(DURATION, "<duration>")
      .replace(HEX_ID, "<id>")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase())
    .filter(Boolean)
    .slice(-5);
  return lines.join("\n").slice(-400);
}

export type DependencyInstallFailureClassification = {
  failureClass: "deterministic" | "transient";
  failureCode: string;
};

const TRANSIENT_SIGNAL = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENOSPC|EDQUOT|EROFS|ENOMEM|EMFILE|ENFILE)\b|socket hang up|getaddrinfo|temporary failure in name resolution|\bnetwork\b|\bregistry\b|\b429\b|\b503\b|\b504\b|rate limit|try again/i;
const INTERPRETER_SIGNAL = /requires-python|no interpreter found|\binterpreter\b.*(?:incompatible|not found|missing)|python[^\n]*not found/i;
const DEPENDENCY_SELECTION_SIGNAL = /(?:unknown|undefined|invalid)\s+(?:dependency\s+)?(?:group|extra)|(?:group|extra)[^\n]*(?:unknown|undefined|not found)/i;

export function classifyDependencyInstallFailure(result: DependencyCommandResult): DependencyInstallFailureClassification {
  const diagnostic = normalizeDependencyDiagnostic(`${result.stderr ?? ""}\n${result.stdout ?? ""}\n${typeof result.spawnError === "string" ? result.spawnError : result.spawnError?.message ?? ""}`);
  if (result.timedOut || result.spawnError || TRANSIENT_SIGNAL.test(diagnostic)) {
    return { failureClass: "transient", failureCode: "DEPENDENCY_INSTALL_TRANSIENT" };
  }
  if (INTERPRETER_SIGNAL.test(diagnostic)) return { failureClass: "deterministic", failureCode: "INTERPRETER_INCOMPATIBLE" };
  if (DEPENDENCY_SELECTION_SIGNAL.test(diagnostic)) return { failureClass: "deterministic", failureCode: "INVALID_DEPENDENCY_SELECTION" };
  return { failureClass: "deterministic", failureCode: "DEPENDENCY_INSTALL_FAILED" };
}

export function dependencyFailureSignature(input: { command: string; exitCode: number | null | undefined; diagnostic: string }): string {
  return createHash("sha256")
    .update(input.command.trim()).update("\0")
    .update(String(input.exitCode ?? "null")).update("\0")
    .update(normalizeDependencyDiagnostic(input.diagnostic))
    .digest("hex")
    .slice(0, 16);
}

export function dependencyFailureRepeatsWithoutChange(
  prior: { signature: string; worktreeState: string } | undefined,
  current: { signature: string; worktreeState: string },
): boolean {
  return Boolean(prior
    && prior.signature === current.signature
    && prior.worktreeState === current.worktreeState
    && prior.worktreeState !== DEPENDENCY_WORKTREE_STATE_INDETERMINATE
    && current.worktreeState !== DEPENDENCY_WORKTREE_STATE_INDETERMINATE);
}
