/*
FNXC:MergerAiSplit 2026-06-25-00:00:
FN-7029 extracts the AI-merge prompt builders and review verdict parser from merger-ai.ts so the sole FN-5633 clean-room merge path stays under the 2000-line guardrail without changing prompts, verdict parsing, or the public merger-ai.js import surface.
*/
import {
  resolveAgentPrompt,
  type AgentPromptsConfig,
  type TaskComment,
} from "@fusion/core";

import { buildUserCommentsPromptSection } from "../agents/agent-user-comments.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export type AiMergeReviewSeverity = "blocking" | "advisory";

export interface AiMergeReviewVerdict {
  verdict: "approve" | "reject";
  reasons: string[];
  severity?: AiMergeReviewSeverity;
  /** Prior findings the reviewer explicitly confirmed are fixed in this squash. */
  resolvedPriorReasons: string[];
  priorFindingDispositions?: Array<{ id: string; disposition: "corrected" | "absent-from-squash" | "still-present" }>;
}

export const REVIEW_VERDICT_MARKER = "REVIEW_VERDICT:";
export const SEVERITY_MARKER = "SEVERITY:";
export const RESOLVED_PRIOR_FINDINGS_MARKER = "RESOLVED_PRIOR_FINDINGS:";
export const PRIOR_FINDING_DISPOSITIONS_MARKER = "PRIOR_FINDING_DISPOSITIONS:";
/*
FNXC:MergerAiReview 2026-08-22-22:04:
FN-090 added the fourth protocol marker without teaching reason recovery about it, letting
Fusion persist its own acknowledgement syntax as blocking feedback. Keep every marker in this
registry so a future fifth marker is rejected by construction at both parser and durable seams.
*/
export const AI_MERGE_PROTOCOL_MARKERS = [REVIEW_VERDICT_MARKER, SEVERITY_MARKER, RESOLVED_PRIOR_FINDINGS_MARKER, PRIOR_FINDING_DISPOSITIONS_MARKER] as const;
const DISPOSITION_BODY_RE = /^[A-Za-z0-9_-]+\s*:\s*(corrected|absent-from-squash|still-present)$/i;
const VERDICT_LINE_RE = /REVIEW_VERDICT:\s*(approve|reject)\b/i;
const SEVERITY_LINE_RE = /SEVERITY:\s*(blocking|advisory)\b/i;
const RESOLVED_PRIOR_FINDINGS_LINE_RE = /RESOLVED_PRIOR_FINDINGS:\s*(.*)$/i;

/*
FNXC:MergerAiReview 2026-07-15-21:30:
Cap on reasons recovered from lines PRECEDING the verdict (FN-8004 follow-up). The reviewer's
free-form analysis can run long; the corrective re-merge prompt only needs the closing argument,
and an unbounded splice would paste an entire transcript into it.
*/
const MAX_RECOVERED_PRECEDING_REASONS = 8;
export const MAX_REASON_CHARS = 500;

/**
 * Parse the reviewer's free-form output. Fail-safe: no/garbled output, or a
 * rejection with no explicit severity, is treated as a BLOCKING reject — an
 * ambiguous reviewer can never wave wrong code through, nor silently downgrade
 * to advisory.
 */
export function parseReviewVerdict(
  agentText: string | null | undefined
): AiMergeReviewVerdict {
  const text = (agentText ?? "").trim();
  if (!text)
    return {
      verdict: "reject",
      reasons: ["reviewer produced no output"],
      severity: "blocking",
      resolvedPriorReasons: [],
    };

  const lines = text.split(/\r?\n/);
  let verdictLineIndex = -1;
  let decision: "approve" | "reject" | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(VERDICT_LINE_RE);
    if (m) {
      decision = m[1].toLowerCase() as "approve" | "reject";
      verdictLineIndex = i;
      break;
    }
  }
  if (!decision) {
    return {
      verdict: "reject",
      reasons: [
        `reviewer did not emit a "${REVIEW_VERDICT_MARKER} approve|reject" line`,
      ],
      severity: "blocking",
      resolvedPriorReasons: [],
    };
  }
  const resolvedPriorReasons = extractResolvedPriorReasons(lines);
  const priorFindingDispositions = extractPriorFindingDispositions(lines);
  if (decision === "approve") return { verdict: "approve", reasons: [], resolvedPriorReasons, ...(priorFindingDispositions.length ? { priorFindingDispositions } : {}) };

  const severity: AiMergeReviewSeverity = SEVERITY_LINE_RE.test(text)
    ? (text.match(SEVERITY_LINE_RE)![1].toLowerCase() as AiMergeReviewSeverity)
    : "blocking";
  const resolvedKeys = new Set(resolvedPriorReasons.map(normalizeReasonIdentity));
  return {
    verdict: "reject",
    // Marker bullets are acknowledgements; reconciliation separately promotes
    // unknown acknowledgements to new findings instead of dropping them.
    reasons: extractRejectReasons(lines, verdictLineIndex)
      .filter((reason) => !resolvedKeys.has(normalizeReasonIdentity(reason))),
    severity,
    resolvedPriorReasons,
    ...(priorFindingDispositions.length ? { priorFindingDispositions } : {}),
  };
}

/**
 * Extract only a clearly delimited, bullet-form resolution acknowledgement.
 * A missing or malformed marker intentionally yields no resolutions: callers
 * retain every prior blocker rather than guessing that reviewer prose cleared it.
 */
function extractResolvedPriorReasons(lines: string[]): string[] {
  const markerIndex = lines.findIndex((line) => RESOLVED_PRIOR_FINDINGS_LINE_RE.test(line));
  if (markerIndex === -1) return [];
  const inline = lines[markerIndex].match(RESOLVED_PRIOR_FINDINGS_LINE_RE)?.[1].trim();
  const resolved = inline && !/^none\b/i.test(inline) ? [inline] : [];
  for (let index = markerIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (VERDICT_LINE_RE.test(line) || SEVERITY_LINE_RE.test(line) || line.trim().toLowerCase().startsWith(PRIOR_FINDING_DISPOSITIONS_MARKER.toLowerCase()) || !line.trim()) break;
    if (!/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) return [];
    resolved.push(cleanReasonLine(line));
  }
  return resolved;
}

/** Parse only explicit stable ids; prose never clears a structured prior finding. */
function extractPriorFindingDispositions(lines: string[]): Array<{ id: string; disposition: "corrected" | "absent-from-squash" | "still-present" }> {
  const index = lines.findIndex((line) => line.trim().toLowerCase().startsWith(PRIOR_FINDING_DISPOSITIONS_MARKER.toLowerCase()));
  if (index === -1) return [];
  const result: Array<{ id: string; disposition: "corrected" | "absent-from-squash" | "still-present" }> = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || VERDICT_LINE_RE.test(line) || SEVERITY_LINE_RE.test(line) || line.trim().toLowerCase().startsWith(RESOLVED_PRIOR_FINDINGS_MARKER.toLowerCase())) break;
    const match = cleanReasonLine(line).match(/^([A-Za-z0-9_-]+)\s*:\s*(corrected|absent-from-squash|still-present)\s*$/i);
    if (match) result.push({ id: match[1], disposition: match[2].toLowerCase() as "corrected" | "absent-from-squash" | "still-present" });
  }
  return result;
}
/** Strip bullet/numeric list markers and surrounding whitespace from one line. */
function cleanReasonLine(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
}

function normalizeReasonIdentity(reason: string): string {
  return reason.trim().toLocaleLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();
}

/** Whether a line is Fusion review protocol rather than reviewer reasoning. */
export function isAiMergeProtocolLine(text: string): boolean {
  const clean = cleanReasonLine(text);
  return AI_MERGE_PROTOCOL_MARKERS.some((marker) => clean.toLowerCase().includes(marker.toLowerCase())) || DISPOSITION_BODY_RE.test(clean);
}

/** Lines that carry no reviewer reasoning and must never be reported as a reason. */
export function isNonReasonLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (SEVERITY_LINE_RE.test(t)) return true;
  if (VERDICT_LINE_RE.test(t)) return true;
  if (RESOLVED_PRIOR_FINDINGS_LINE_RE.test(t)) return true;
  /* FNXC:MergerAiReview 2026-08-22-22:26: Protocol markers at line start stay non-reasons even with malformed values; inline marker prose is left to the durable-corpus defence-in-depth boundary. */
  if (AI_MERGE_PROTOCOL_MARKERS.some((marker) => t.toLowerCase().startsWith(marker.toLowerCase()))) return true;
  if (DISPOSITION_BODY_RE.test(cleanReasonLine(t))) return true;
  // Markdown scaffolding the reviewer may emit around its analysis.
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^(?:-{3,}|={3,}|`{3,})/.test(t)) return true;
  return false;
}

/*
FNXC:MergerAiReview 2026-07-15-14:45:
FN-8004 corrective merges must receive reviewer conclusions, never pasted diff or tool output. Track Markdown fences while recovering reasons on either side of a verdict so nearby evidence cannot displace actionable feedback.

FNXC:MergerAiReview 2026-08-22-22:04:
FN-159 groups contiguous review prose because treating every line as a finding split one actionable
multi-line objection into truncated fragments that no corrective merge could address reliably.
*/
function collectReasonLines(lines: string[], start: number, end: number, step: 1 | -1): string[] {
  const reasons: string[] = [];
  let group: string[] = [];
  let inFence = false;
  const flush = () => {
    if (!group.length) return;
    const ordered = step === -1 ? group.reverse() : group;
    const reason = ordered.join(" ");
    reasons.push(reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason);
    group = [];
  };
  for (let i = start; step === 1 ? i < end : i >= end; i += step) {
    const line = lines[i];
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) { flush(); inFence = !inFence; continue; }
    if (inFence || isNonReasonLine(line)) { flush(); continue; }
    if (bullet && step === 1) flush();
    group.push(cleanReasonLine(line));
    if (bullet && step === -1) flush();
    if (reasons.length >= MAX_RECOVERED_PRECEDING_REASONS) break;
  }
  flush();
  return reasons.slice(0, MAX_RECOVERED_PRECEDING_REASONS);
}

/*
FNXC:MergerAiReview 2026-07-15-21:30:
FN-8004 follow-up. The prompt tells the reviewer to "End with a single decision line", so a
compliant reviewer writes its reasoning ABOVE `REVIEW_VERDICT: reject` and ends on the verdict.
This function only scanned lines AFTER the verdict line, so those reasons were discarded and the
rejection degraded to the placeholder "rejected the merge without a stated reason" — which was then
handed to the corrective re-merge pass as its instruction. The corrective pass thus received no
actionable feedback and merely re-rolled the merge, which typically passed on the next review.

Observed on FN-8004's own merge: BOTH attempts went reject(no reason) → corrective pass → approve,
burning ~7 min per cycle and pushing each attempt past main's ~8-min churn window into a livelock.
That is a lost-reason bug, not a reviewer that genuinely objects twice and then relents.

Reason precedence: inline (same line as the verdict) → lines after the verdict → lines before it
(nearest-first, the "End with the verdict" layout). Falling back to the preceding lines is what
makes a compliant reviewer's rejection actionable. Keep the prompt's ordering guidance and this
precedence in sync — see buildMergeReviewSystemPrompt.
*/
function extractRejectReasons(
  lines: string[],
  verdictLineIndex: number
): string[] {
  const reasons: string[] = [];
  const inline = lines[verdictLineIndex]
    .replace(VERDICT_LINE_RE, "")
    .replace(/^[\s:–—-]+/, "")
    .trim();
  if (inline) reasons.push(inline);
  reasons.push(...collectReasonLines(lines, verdictLineIndex + 1, lines.length, 1));
  if (reasons.length === 0) {
    // Walk backwards from the verdict so the reviewer's closing argument — the part
    // most likely to state the blocking defect — is reported first.
    reasons.push(...collectReasonLines(lines, verdictLineIndex - 1, 0, -1));
  }
  if (reasons.length === 0)
    reasons.push("reviewer rejected the merge without a stated reason");
  return reasons;
}

export function buildMergeSystemPrompt(
  agentPrompts?: AgentPromptsConfig
): string {
  // Base persona is the editable "merger" agent prompt (Settings → Prompts);
  // the non-negotiable clean-room / verification / commit-trailer rules below
  // are always appended so a custom prompt can't drop them.
  const base = resolveAgentPrompt("merger", agentPrompts).trim();
  return [
    base,
    base ? "" : undefined,
    "## AI merge — clean room",
    "You are on a CLEAN, detached checkout at the integration branch's current",
    "tip. Land the task branch's work as a single commit.",
    "",
    "Constraints:",
    "  - Resolve every conflict in favor of the task branch's intent; never drop",
    "    the task's changes to make a conflict go away.",
    "  - Do not make edits unrelated to reconciling the two branches.",
    "  - Do NOT push, force-push, or run `git update-ref` / `git reset --hard`",
    "    on any other branch. Only commit on this detached HEAD.",
    "  - Finish with exactly ONE new commit on HEAD containing the task's work.",
    "",
    "Verify before committing:",
    "  - After resolving the merge, run the project's checks — tests, type-check,",
    "    and lint (discover them from the project config / package.json scripts,",
    "    e.g. test / typecheck / lint / build).",
    "  - FIX any NEW failure the merge or conflict resolution introduced (a check",
    "    that passed on the task branch or the integration tip but fails on the",
    "    merged tree). You do not need to fix failures that were already broken on",
    "    the integration branch beforehand, but never commit a merge that adds new",
    "    test, type-check, or lint failures.",
    "",
    "Commit message:",
    "  - The subject line must CONCISELY SUMMARIZE the squashed changes in",
    '    imperative mood (e.g. "add X", "fix Y") based on the actual diff — do',
    "    not just restate the task title.",
    "  - The commit BODY must include:",
    "      1) one short narrative summary line,",
    "      2) a bullet list of key changes, and",
    "      3) a `Files changed:` section populated from `git diff --stat`.",
    "  - Include the task-id prefix and the trailer lines EXACTLY as given in the",
    "    task instructions (they associate the commit with the board task).",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

export function buildMergePrompt(input: {
  taskId: string;
  branch: string;
  integrationBranch: string;
  tipSha: string;
  /** Task title — a HINT for the summary, not the literal subject. */
  taskTitle?: string;
  /** Whether to prefix the subject with the task id. */
  includeTaskId: boolean;
  /** Required trailers to append (board association). */
  trailers: string[];
  correctiveReasons?: string[];
  userComments?: TaskComment[];
}): string {
  const subjectShape = input.includeTaskId
    ? `"${input.taskId}: <concise imperative summary of the squashed changes>"`
    : `"<concise imperative summary of the squashed changes>"`;
  const trailerArgs = input.trailers
    .map((t) => ` -m ${JSON.stringify(t)}`)
    .join("");
  const lines = [
    `Merge branch "${input.branch}" into "${
      input.integrationBranch
    }" (HEAD is detached at ${short(input.tipSha)}).`,
    "",
    "Steps:",
    `  1. Run: git merge --squash ${input.branch}`,
    "  2. If there are conflicts, resolve them (favor the task's intent), then `git add` the resolved files.",
    "  3. Build a merge body from the staged squash diff:",
    "       - one short narrative summary line",
    "       - bullet list of key changes",
    "       - `Files changed:` + the output of `git diff --stat`",
    "  4. Commit the staged result as a SINGLE commit whose subject summarizes the",
    `     actual changes${
      input.taskTitle
        ? ` (task title hint: ${JSON.stringify(input.taskTitle)})`
        : ""
    }, including the body above and required trailers:`,
    `       git commit -m ${subjectShape} -m "<narrative + bullet list + Files changed: ...>"${trailerArgs}`,
    "     Keep the trailer line(s) verbatim — they link the commit to the board task.",
    "  5. Verify `git log --oneline ${tip}..HEAD` shows exactly one new commit and `git status` is clean.".replace(
      "${tip}",
      short(input.tipSha)
    ),
    "",
    "If `git merge --squash` reports the branch is already up to date (nothing to",
    "merge), do nothing and leave HEAD unchanged.",
  ];
  const userCommentsSection = buildUserCommentsPromptSection(
    input.userComments ?? []
  );
  if (userCommentsSection) {
    lines.push("", userCommentsSection);
  }
  if (input.correctiveReasons && input.correctiveReasons.length > 0) {
    lines.push(
      "",
      "A prior attempt was REJECTED by review. Redo the merge from the clean tip",
      "and address each of these problems:",
      ...input.correctiveReasons.map((r) => `  - ${r}`)
    );
  }
  return lines.join("\n");
}

export function buildReviewSystemPrompt(): string {
  return [
    "You are an adversarial, read-only merge reviewer. Do NOT edit, stage, commit,",
    "or run any mutating git command. Audit the squash commit that is about to be",
    "merged into the integration branch and decide whether it is safe to land.",
    "",
    "Investigate with read-only commands (git show, git diff, git log, cat, grep).",
    "Judge the squash's fidelity on four axes:",
    "  1. Branch preservation — does the squash preserve the task branch's",
    "     changes? Flag any hunk silently dropped during conflict resolution.",
    "  2. No collateral — does the squash add unrelated changes outside its",
    "     branch/squash footprint?",
    "  3. Conflict soundness — were conflicts resolved coherently (both relevant",
    "     branch intents retained), not by blindly discarding one side?",
    "  4. Commit message — read `git show`'s message: the subject must concisely",
    "     and ACCURATELY summarize the actual changes (not vague, not a mere",
    "     restatement of the task title, not misleading). A poor/inaccurate",
    "     message is an ADVISORY concern (it should be rewritten on retry, but",
    "     must not block the merge).",
    "",
    "Whole-tree semantic or intent concerns in files untouched by this squash are",
    "ADVISORY or follow-up material, never a blocking veto: the merger is not",
    "authorized to edit outside branch reconciliation.",
    "",
    "Bias toward rejection when uncertain about squash fidelity.",
    "",
    /*
    FNXC:MergerAiReview 2026-07-15-21:30:
    FN-8004 follow-up. This block used to say "End with a single decision line ... Then list each
    concrete reason as a bullet" — self-contradictory: a reviewer cannot both END on the verdict
    and list reasons after it. Reviewers obeyed "End with", so the reasons landed above the verdict
    where the parser did not look, and every rejection degraded to "without a stated reason".
    The ordering below is now unambiguous: reasons FIRST, verdict LAST. The parser additionally
    recovers reasons from either side (see extractRejectReasons), so both layouts stay actionable.
    */
    "When rejecting, first list each concrete reason as its own bullet — state the",
    "specific defect (what was dropped, lost, or wrongly resolved), not a generic",
    "objection. These bullets are fed verbatim to the corrective re-merge pass, so a",
    "vague reason produces a blind retry rather than a fix.",
    "",
    `Then add a "SEVERITY:" line:`,
    "  - SEVERITY: blocking — a squash-fidelity defect: dropped/lost branch",
    "    changes, unrelated collateral in the squash, or a conflict resolution",
    "    that discards relevant branch intent. The merge must NOT land if unfixable.",
    "  - SEVERITY: advisory — a quality/style concern that does not risk",
    "    correctness; acceptable to land if unresolved.",
    "",
    `Finish with a single decision line, and nothing after it:`,
    `"${REVIEW_VERDICT_MARKER} approve" or "${REVIEW_VERDICT_MARKER} reject".`,
  ].join("\n");
}

export function buildReviewPrompt(input: {
  taskId: string;
  branch: string;
  integrationBranch: string;
  tipSha: string;
  squashSha: string;
  diffStat: string;
  priorReasons?: string[];
  priorFindings?: Array<{ id: string; text: string }>;
  userComments?: TaskComment[];
}): string {
  const lines = [
    `Review the squash merge for task ${input.taskId} (branch ${input.branch} → ${input.integrationBranch}).`,
    "",
    `Integration tip: ${short(input.tipSha)}`,
    `Squash commit:   ${short(input.squashSha)}`,
    "",
    "Inspect with:",
    `  git show ${input.squashSha}`,
    `  git diff ${input.tipSha}..${input.squashSha}`,
    "",
    "Files changed (git diff --stat):",
    input.diffStat.trim() || "(none reported)",
  ];
  const userCommentsSection = buildUserCommentsPromptSection(
    input.userComments ?? []
  );
  if (userCommentsSection) {
    lines.push("", userCommentsSection);
  }
  if (input.priorReasons && input.priorReasons.length > 0) {
    lines.push(
      "",
      "Report each numbered prior finding under PRIOR_FINDING_DISPOSITIONS: as <id>: corrected, absent-from-squash, or still-present.",
      "Omitted, malformed, duplicate, and unknown IDs retain the finding; prose never clears it.",
      "Do not use whole-tree concerns outside this squash's footprint as blockers:",
      ...(input.priorFindings ?? input.priorReasons.map((text, index) => ({ id: `legacy-${index + 1}`, text }))).map((finding) => `  - ${finding.id}: ${finding.text}`)
    );
  }
  return lines.join("\n");
}

export function buildStashResolveSystemPrompt(): string {
  return [
    "You are resolving a conflict between the user's restored local working-tree",
    "edits and the freshly-merged integration branch. The user's uncommitted work",
    "was stashed, the checkout fast-forwarded to the new tip, and re-applying the",
    "stash produced conflicts.",
    "",
    "Resolve every conflict marker so BOTH sides are preserved: keep the user's",
    "local intent AND the upstream changes that just landed. Stage each resolved",
    "file with `git add`.",
    "",
    "Do NOT commit, stash, reset, checkout a different branch, or run update-ref.",
    "Leave the resolved changes in the working tree as the user's uncommitted edits.",
  ].join("\n");
}

export function buildStashResolvePrompt(conflictedFiles: string[]): string {
  return [
    "Re-applying your stashed local changes onto the updated branch conflicted.",
    "",
    "Conflicted files:",
    ...conflictedFiles.map((f) => `  - ${f}`),
    "",
    "Resolve each file's conflict markers (preserve both the local edits and the",
    "upstream changes), then `git add` it. Do not commit.",
  ].join("\n");
}

function short(sha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 8) : sha;
}
