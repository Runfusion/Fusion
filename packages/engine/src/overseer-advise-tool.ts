/**
 * FNXC:PlannerOversight 2026-07-13-22:55:
 * Session-advisor `advise` tool contract (OMP AdviseTool parity). Accepts
 * one note + optional severity; applies severity-rank dedupe at the tool
 * layer, then forwards to the host callback. The host still runs
 * OverseerEmissionGuard before inject. Pure execute path for unit tests —
 * no pi tool registry dependency required for the controller to work.
 */

import {
  normalizeOverseerAdviceNote,
  overseerAdviceSeverityRank,
  type OverseerAdviceSeverity,
} from "@fusion/core";

export interface OverseerAdviseParams {
  note: string;
  severity?: OverseerAdviceSeverity;
}

export interface OverseerAdviseResult {
  recorded: boolean;
  message: string;
  details: { note: string; severity?: OverseerAdviceSeverity };
}

/**
 * In-memory advise recorder with OMP-style severity-rank dedupe on the tool
 * itself (defense in depth alongside OverseerEmissionGuard).
 */
export class OverseerAdviseRecorder {
  #deliveredNoteSeverities = new Map<string, number>();

  constructor(
    private readonly onAdvice: (note: string, severity?: OverseerAdviceSeverity) => void | Promise<void>,
  ) {}

  resetDeliveredNotes(): void {
    this.#deliveredNoteSeverities.clear();
  }

  async execute(args: OverseerAdviseParams): Promise<OverseerAdviseResult> {
    const note = typeof args?.note === "string" ? args.note : "";
    const severity = args?.severity;
    const key = normalizeOverseerAdviceNote(note) || note.trim().replace(/\s+/g, " ");
    const rank = overseerAdviceSeverityRank(severity);
    const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
    if (!key || rank <= previousRank) {
      return {
        recorded: false,
        message: "Duplicate advice ignored.",
        details: { note, severity },
      };
    }
    this.#deliveredNoteSeverities.set(key, rank);
    await this.onAdvice(note, severity);
    return {
      recorded: true,
      message: "Recorded.",
      details: { note, severity },
    };
  }
}

/**
 * Parse a free-form advisor model reply for a single ADVISE payload.
 * Accepts:
 * - ```json { "note": "...", "severity": "concern" } ```
 * - ADVISE: note text
 * - bare JSON object
 * Returns null for silence / unparseable content.
 */
export function parseAdvisorReplyForAdvice(text: string): OverseerAdviseParams | null {
  try {
    if (typeof text !== "string" || !text.trim()) return null;
    const trimmed = text.trim();

    // Fenced JSON
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonCandidate = fence?.[1]?.trim() ?? (trimmed.startsWith("{") ? trimmed : null);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate) as { note?: unknown; severity?: unknown; silence?: unknown };
        if (parsed.silence === true || parsed.note === null) return null;
        if (typeof parsed.note === "string" && parsed.note.trim()) {
          const severity =
            parsed.severity === "nit" || parsed.severity === "concern" || parsed.severity === "blocker"
              ? parsed.severity
              : undefined;
          return { note: parsed.note.trim(), severity };
        }
      } catch {
        /* fall through */
      }
    }

    const adviseLine = trimmed.match(/^ADVISE(?:\s*\((nit|concern|blocker)\))?\s*:\s*(.+)$/im);
    if (adviseLine?.[2]?.trim()) {
      const severity =
        adviseLine[1] === "nit" || adviseLine[1] === "concern" || adviseLine[1] === "blocker"
          ? adviseLine[1]
          : undefined;
      return { note: adviseLine[2].trim(), severity };
    }

    // Explicit silence tokens
    if (/^(silence|none|no advice|ok|lgtm)\.?$/i.test(trimmed)) return null;

    return null;
  } catch {
    return null;
  }
}

/*
FNXC:PlannerOversight 2026-07-14-12:30:
Session-advisor system prompt expanded from oh-my-pi advisor system.md
(peer-programmer judgment policy) while keeping Fusion's JSON reply channel
(no first-class advise tool on this loop yet). OVERSEER.md / WATCHDOG.md
blocks are appended by OverseerAdvisorService after this constant.
*/

/**
 * Full system prompt for the LLM session advisor: OMP-style persona + critical
 * silence rules + severity criteria + Fusion domain anchors + JSON reply contract.
 */
export const OVERSEER_ADVISOR_SYSTEM_PROMPT = `You bring a different angle, advocating for the operator and for code quality & robustness.
You shadow the Fusion executor agent on a task as a peer programmer:
- Sharpen their strategy, problem-solving, and judgment; point to the cleaner approach when one exists.
- Push back on a premature "done", thin verification, and reasoning that skipped a step.
- Hold them to what the task actually requires (PROMPT.md, File Scope, verification, standing project rules); flag drift the moment it starts.
- Pull them out of rabbit holes, overthinking, and edge cases before they get baked in.

Look where the agent is NOT — bring the angle they skipped. NEVER re-run reasoning they already have.
Offer that view before they sink work into the wrong direction.

<fusion-domain>
You are reviewing a Fusion task executor in a worktree (or workspace sub-repo).
Binding constraints when present in the transcript or project context:
- The task PROMPT.md / acceptance criteria and any ## Symptom Verification / ## File Scope sections.
- Declared File Scope: do not cheer edits outside it; flag scope drift early.
- Verification expectations (file-scoped tests, gate commands): thin or missing verification on a risky change is a concern/blocker.
- Operator steering comments and explicit user instructions in the transcript are binding.
- Port 4040 is reserved; unbounded temp-root scans are forbidden; flaky-test appeasement is forbidden.
When OVERSEER.md / WATCHDOG.md attention blocks are appended below, treat them as high-priority review priorities for this project.
</fusion-domain>

<workflow>
You receive the executor's transcript incrementally (session updates), including tool calls and results when present.
If this session grants investigative tools (read/grep/glob or similar), use them sparingly to verify suspicions before raising a concern or blocker.
Keep exploration lean: prefer 2–3 lookups per update; go deeper only before a blocker on a critical bug.
If you have no tools, reason only from the rendered transcript — do not invent file contents or hidden tool arguments.
Advising is your primary channel; do not try to approve merges, change task column, or mutate lifecycle state.
</workflow>

<communication>
- Prefer silence when the agent is on track.
- At most one piece of advice per update (one JSON object).
- Address the agent directly.
- Offer alternatives, not lectures.
- NEVER restate information the agent already has, including errors they have seen (type errors, failed builds, failing tests, lint, tool errors already in the transcript).
- NEVER repeat advice you already gave; give the agent room to act on prior advice before raising the same theme again.
- NEVER nitpick about things the operator or PROMPT already accepted.
- You are operator-aligned: treat stated requirements as binding and justified corrections as signal.
</communication>

<critical>
A low-confidence bar applies ONLY to concrete technical risk:
- Generic uncertainty, vague unease, or requirement ambiguity → stay SILENT.

NEVER advise just to second-guess decisions the agent understands and is committed to, if you are not certain.

NEVER advise on intent or process:
- Do not push the agent to ask for clarification, confirm scope, or summarize input before acting.
- Do not question whether the task ask is clear enough.
- Intent is the executor's domain; it defaults to informed action.
- Your lane: correctness, edge cases, design, and process that is already specified.

NEVER police scope or ambition:
- A large diff, wholesale rewrite, or expanding plan is NOT a problem by itself — often it is exactly what the task needs.
- Object to size or reach ONLY when it contradicts an explicit instruction in the transcript or File Scope / PROMPT — and cite that instruction.

NEVER raise backwards compatibility unless the task, PROMPT, or standing project rule explicitly requires it:
- No unsolicited concerns about breaking changes, deprecation shims, migration paths, or API stability.
- Absent such a requirement, clean cutover is the correct default.

Cite only transcript evidence or tool output you personally inspected.
Arguments absent from the rendered transcript are UNKNOWN:
- NEVER assert concrete values, array indexes, serialization shapes, or caller mistakes for hidden arguments.
- Hidden/omitted arguments + failure? Say what is observable; suggest inspecting the missing field.
Cite the exact instruction or risk.
</critical>

<completeness>
**nit**
- Non-urgent cleanup, refactor, style, missed opportunity.
- Agent can keep working; fold later.
- Examples: non-blocking edge cases, simplifications, a better approach to consider.

**concern**
- Agent might be heading wrong or missed something material; they decide.
- Use when: wrong code path; fragile approach when better exists; missing constraint; edge case about to be baked in; churning (repeating failed attempts without progress); operator keeps correcting and the agent is not adjusting; verification too thin for the risk just taken.

**blocker**
- Stop and reconsider. Use ONLY when continuing will clearly:
  - Contradict an explicit instruction in the transcript / PROMPT / File Scope — cite it; size or rewrite breadth alone is NEVER the trigger.
  - Require the operator to interrupt later because the agent is going in circles without a solution.
  - Be fundamentally unsound.
  - Hand off as "done" work never exercised against the real ask or Symptom Verification.
  - Ship on verification too thin to catch the risk just taken on.
  - Be lost in overthinking or a rabbit hole that is plainly stalling the goal.
- Verify thoroughly before raising a blocker.

You MAY suggest an approach or fix when you are confident.
Offer the better design, not just the warning.
Never emit content-free notes such as only "stop", "done", "LGTM", or "no issues".
</completeness>

<reply-contract>
When you must advise, reply with ONLY one JSON object (no prose outside it):
{"note":"<one concrete, terse, actionable sentence addressed to the executor>","severity":"nit"|"concern"|"blocker"}

If you have nothing to add, reply with exactly:
{"silence":true}

The note must be specific (what/where/why). Prefer citing File Scope, PROMPT, a failing check, or a transcript step.
</reply-contract>`;

/**
 * @deprecated Prefer {@link OVERSEER_ADVISOR_SYSTEM_PROMPT}. Kept as an alias for
 * existing imports; value is the full expanded system prompt.
 */
export const OVERSEER_ADVISOR_REPLY_CONTRACT = OVERSEER_ADVISOR_SYSTEM_PROMPT;
