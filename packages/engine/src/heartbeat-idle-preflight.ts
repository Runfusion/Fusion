/*
FNXC:HeartbeatIdlePreflight 2026-11-01-01:05 (RUFU-268):
A WAKE THAT CANNOT BE SKIPPED SHOULD AT LEAST COST A QUESTION, NOT A BRIEFING.

STAS-300 made a tick whose signals are all at or behind the acknowledged cursor free, and the RUFU-268
ladder stretches how often an idle agent is asked at all. Neither helps the tick that IS admissible: a
card moved column, so the board really did change, and the agent opens a full session — identity, soul,
instructions, procedure, skills, the board dump, the candidate table — to discover that the move meant
nothing to it. That session is the residual cost, and its answer was knowable in one line.

So an admissible idle tick is first asked that one line: a tool-less turn whose head is a constant,
whose body is nothing but the candidate ids, and whose answer is `WORK` or `NOOP`. `NOOP` costs the
agent one acknowledgement and buys the next ladder step; `WORK` spends the full session it would have
spent anyway.

Why this module holds only the pure parts:
- The head must stay byte-identical across every agent and every tick, because that prefix is what a
  provider cache can reuse — the whole point of the exercise. Candidate ids are runtime-mutable, so
  they ride the request tail through RUFU-267's `appendRequestVolatileContext`, never the head
  (`scripts/check-prompt-volatility.mjs` exists because this exact mistake shipped before). The
  byte-stability claim is therefore testable as `expect(second).toBe(first)`, and only in a module that
  cannot see an agent row.
- The session call itself stays in `HeartbeatMonitor`, where `pi.js` is already the mocked seam for the
  heartbeat suites. A module that constructed its own session would be a lane nothing currently tests.

Deliberate conservatism, in one table:
| situation                    | verdict        | consequence            |
|------------------------------|----------------|------------------------|
| exactly `WORK`               | work           | full session, as today |
| exactly `NOOP`               | noop           | acknowledged, no session |
| anything else, empty, mixed  | unavailable    | full session           |
| session or provider failure  | unavailable    | full session           |
| a delta that is NOT board-only | not attempted | full session         |
Every non-`NOOP` outcome spends the session the agent would have spent before this change existed, so
the cheapest possible turn can never be the reason real work was skipped.
*/

import { SESSION_CONTEXT_HEADING, appendRequestVolatileContext } from "./execution/prompt-layers.js";

/** How many candidate ids the compact turn is allowed to name. Beyond this it is no longer compact. */
export const IDLE_PREFLIGHT_MAX_CANDIDATE_IDS = 40;

/**
 * The tool-less head. Constant by construction: no interpolation, no agent row, no board state. If this
 * string ever gains a per-agent field the cache win is gone and `heartbeat-idle-preflight.test.ts`'s
 * byte-stability assertion is the thing that says so.
 */
export const IDLE_PREFLIGHT_SYSTEM_PROMPT = [
  "You are one turn in a scheduled heartbeat. You have no tools and no board dump.",
  "The only thing you are given is the list of task ids currently offered to you.",
  "Answer exactly one line, one word:",
  "WORK - something in that list needs you this tick: it is yours, or you can claim it and act now.",
  "NOOP - nothing in that list needs you: a card moved, was reordered, or appeared where you will not act.",
  "Say NOOP only when you are sure. If the change could plausibly need you, say WORK.",
  "Never explain, never restate an id, never ask a question.",
].join("\n");

/**
 * What the compact turn concluded. `unavailable` is not a failure — it is "this tick is not provably a
 * board-only delta, or the turn did not answer cleanly", and every one of those means the full path.
 */
export type IdlePreflightVerdict = "noop" | "work" | "unavailable";

/** Cap and shape the id list before it reaches the model, so the turn cannot grow into a board dump. */
export function clampIdlePreflightCandidateIds(candidateIds: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const rawId of candidateIds) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (id.length > 0 && id.length <= 64) seen.add(id);
    if (seen.size >= IDLE_PREFLIGHT_MAX_CANDIDATE_IDS) break;
  }
  return [...seen].sort();
}

/**
 * The compact request. The heading and the id list are the ENTIRE payload — no identity, no soul, no
 * instructions, no procedure, no skills, and no board table.
 *
 * `appendRequestVolatileContext` is used rather than string concatenation so this turn's mutable content
 * is placed by the same helper every other lane uses, which keeps the rule "the head never carries
 * runtime state" enforced in one place instead of by convention per caller.
 */
export function buildIdlePreflightRequest(candidateIds: readonly string[]): string {
  const ids = clampIdlePreflightCandidateIds(candidateIds);
  const volatileContext = [
    SESSION_CONTEXT_HEADING,
    `Offered task ids (${ids.length}): ${ids.length > 0 ? ids.join(", ") : "(none)"}`,
  ].join("\n");
  return appendRequestVolatileContext("Should I act on any of these this tick?", volatileContext);
}

/**
 * Read the verdict. Deliberately exact-token: the NOOP branch is the only path in the whole heartbeat
 * that ends without a session, so a reply that is merely SUGGESTIVE of idleness is not evidence of it.
 * A word inside a sentence does not count, and neither does a reply that names both tokens.
 */
export function parseIdlePreflightVerdict(text: unknown): IdlePreflightVerdict {
  if (typeof text !== "string") return "unavailable";
  const lines = text.split("\n").map((line) => line.replace(/[^A-Za-z]/g, "").toUpperCase()).filter(Boolean);
  const tokens = new Set(lines);
  if (tokens.size !== 1) return "unavailable";
  const [only] = [...tokens];
  if (only === "NOOP") return "noop";
  if (only === "WORK") return "work";
  return "unavailable";
}
