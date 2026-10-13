import type { MoveTaskOptions } from "@fusion/core";

/**
 * FNXC:CompleteColumnGateEvidence 2026-10-11-19:35 (RUFU-406):
 * How the CLI transport classifies WHO is holding the keyboard for a board move, so the refusal row
 * can tell an agent's shell from a human terminal. Measured 2026-09-29: RUFU-389 was carried into the
 * terminal lane by an agent's `fn task move` while its only gate row was `plan-review / APPROVE` — zero
 * `code-review` rows — and the durable record read `moveSource:"user"`, which is the INTENT contract
 * (`fn task move` is a board action, so it is honest) but says nothing about the principal. This is the
 * provenance half of that gap; it never gates, because a card with no gate evidence is refused for an
 * operator and an agent alike.
 *
 * THE MARKER IS UPSTREAM-DOCUMENTED, NOT INVENTED. Pi (the runtime that hosts every Fusion agent
 * session) injects `PI_SESSION_ID` / `PI_SESSION_FILE` into its LLM-callable `bash` tool and deletes
 * them from the inherited environment first, so a nested or spoofed value cannot survive a spawn; its
 * own docs state they are NOT injected into a human's `!` / `!!` shell escape
 * (`@earendil-works/pi-coding-agent` `docs/environment-variables.md`, `core/tools/bash.js`). Presence
 * therefore means "this process was spawned by a coding agent's shell tool".
 *
 * THE LIMITS ARE PART OF THE CONTRACT, stated rather than papered over:
 * - Only the principal is labelled, never the verdict — see above.
 * - A shell that strips the variables reads as `operator-cli`. Stripping them takes deliberate action
 *   and buys nothing, since the refusal is identical either way.
 * - A runtime that does not export these variables (a non-Pi executor CLI) reads as `operator-cli`
 *   today; that is under-attribution, never over-attribution of human authority.
 * - The value is an id (the session id), never prose, and it is NOT a Fusion `agentId`: no marker in a
 *   shell environment carries one. An operator resolves the owner through the `sessionFile` persisted
 *   on the task/agent row, which this id matches.
 */

/** Session-identity markers exported by the hosting coding-agent shell (see header). */
const SESSION_ID_MARKERS = ["PI_SESSION_ID", "PI_SESSION_FILE"] as const;

export type MoveCallerClassification = {
  moveCallerSurface: NonNullable<MoveTaskOptions["moveCallerSurface"]>;
  moveCallerPrincipal?: { sessionId?: string };
};

/**
 * Classify a CLI board move from the process environment. `env` is injectable so the classification is
 * asserted without touching real process state; an empty environment is the human-terminal case.
 */
export function classifyCliMoveCaller(
  env: Record<string, string | undefined> = process.env,
): MoveCallerClassification {
  for (const marker of SESSION_ID_MARKERS) {
    const value = env[marker]?.trim();
    if (!value) continue;
    // `PI_SESSION_FILE` is an absolute path; only the session id (its basename without extension) is
    // durable-record safe — run-audit metadata carries ids, never paths. A path with no usable stem still
    // proves the CLASS (the variable exists), so the surface is not downgraded; the principal just carries
    // no id rather than a fabricated one.
    const sessionId = marker === "PI_SESSION_FILE" ? basenameSessionId(value) : value;
    return { moveCallerSurface: "agent-cli", moveCallerPrincipal: sessionId ? { sessionId } : {} };
  }
  return { moveCallerSurface: "operator-cli" };
}

/** `…/2026-10-10T21-54-06-556Z_01a127cf-….jsonl` → `2026-10-10T21-54-06-556Z_01a127cf-…`. */
function basenameSessionId(sessionFile: string): string | undefined {
  const base = sessionFile.split(/[\\/]/).pop();
  if (!base) return undefined;
  return base.replace(/\.jsonl$/i, "") || undefined;
}

/** Move options every `fn task move`-class CLI write carries: the intent contract plus provenance. */
export function cliMoveCallerOptions(
  env: Record<string, string | undefined> = process.env,
): Pick<MoveTaskOptions, "moveCallerSurface" | "moveCallerPrincipal"> {
  const { moveCallerSurface, moveCallerPrincipal } = classifyCliMoveCaller(env);
  return moveCallerPrincipal ? { moveCallerSurface, moveCallerPrincipal } : { moveCallerSurface };
}
