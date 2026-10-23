/**
 * Deterministic (tier-3) chat compaction — the LAST honest reduction before a refusal.
 *
 * FNXC:ChatOverflowCompaction 2026-09-04-18:49:
 * RUFU-182 shipped tiers 1-2: one LLM compaction plus one escalation, all honest refusals when the
 * provider 502s, returns an empty/non-reducing summary, or reports "Already compacted". The failure
 * mode it left open: a session already over the threshold whose summarizer keeps failing is
 * PERMANENTLY unsendable — a user cannot even say "switch models" or "stop" because every send is
 * refused before the prompt runs (docs/research/volt-lcm-analysis.md). Tier 3 closes that with a
 * reduction that cannot fail the way an LLM reduction fails: deterministic truncation with no model
 * call. This module is deliberately the ONLY place that shape lives, and it is a provably non-LLM
 * seam — it imports only pi's pure token/projection helpers, never generateSummary / compact. The
 * companion test file asserts exactly that, so "deterministic, not 'usually deterministic'" stays an
 * architectural property instead of a code-review hope.
 *
 * Convergence is arithmetic, not optimism (spec 2a): the caller hands in a message-token budget that
 * already excludes the static prompt/tool floor, and the split is chosen so
 *   digestTokens + keptTokens < budget
 * holds by construction, where `digestTokens` is priced with the SAME pi estimator that
 * freshLoadedContextEstimate uses to re-measure after the rebuild. The caller re-measures to prove
 * it; this module only ever returns a plan that already fits or `null` meaning "deterministic
 * compaction cannot converge either" — the caller's honest static-floor signal.
 */

import { estimateTokens, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * A deterministic fallback compaction plan, ready to be appended as a pi `CompactionEntry`
 * (`fromHook: true`) and then rebuilt into the live view.
 */
export interface DeterministicFallbackPlan {
  /**
   * The digest text. Declares itself a deterministic truncation, lists what was dropped, and marks
   * omitted surfaces (images, oversized tool output) instead of silently shortening them.
   */
  summary: string;
  /** Entry id the kept suffix starts at; always a turn-start entry so no tool result is orphaned. */
  firstKeptEntryId: string;
  /** Loaded-context tokens before the fallback, echoed for the durable entry and reopen display. */
  tokensBefore: number;
  droppedEntryCount: number;
  keptEntryCount: number;
  /** Tokens the digest itself will cost in the rebuilt context. */
  digestTokens: number;
  /** Tokens of the kept (verbatim, newest) suffix. */
  keptTokens: number;
}

export interface DeterministicFallbackInput {
  /**
   * The ACTIVE compaction-aware context entries, root→leaf: `sessionManager.buildContextEntries()`.
   * A prior compaction entry is included by pi and is folded into the digest rather than kept, so
   * the fallback supersedes it instead of stacking a second summary on top of the first.
   */
  activeEntries: readonly SessionEntry[];
  /**
   * Token budget available to the rebuilt MESSAGE list: `compactionTarget - staticContextFloorEstimate`.
   * The static floor is subtracted by the caller because deterministic rewriting cannot shrink the
   * system prompt or tool schemas; a non-positive budget means the floor alone is at/over the target
   * and no plan can be produced.
   */
  messageTokenBudget: number;
  /** The gate's measured loaded-context tokens before this reduction. */
  tokensBefore: number;
  /**
   * Lowest index the kept suffix may start at. MUST be the index of the first entry that follows the
   * session's live compaction in real leaf-path order (empty active compaction ⇒ 1).
   *
   * FNXC:ChatOverflowCompaction 2026-09-04-18:49:
   * `buildContextEntries` reconstructs the kept set as "everything from firstKeptEntryId up to the
   * newest compaction", so it re-projects ANY compaction still sitting between `firstKeptEntryId`
   * and the new leaf. A prior compaction keeps the recent tail as entries that precede it in the
   * leaf path; splitting inside that tail would make the new compaction re-include the old one and
   * double-count it — the projected context would not shrink as much as the plan promised (route
   * optimism). Forcing the split past the live compaction keeps supersession clean, and it never
   * costs the newest turn (that always lives after the compaction) — only the older kept tail,
   * which is being folded into this emergency digest anyway. The caller derives it as
   * `activeEntries.length - (leafPath.length - latestCompactionIndex - 1)`.
   */
  minSplitIndex?: number;
}

/** One active entry reduced to what the split search and the digest need. */
interface ContextUnit {
  entryId: string;
  projected: Parameters<typeof estimateTokens>[0][];
  tokens: number;
  isTurnStart: boolean;
}

/** Roles pi treats as the start of a turn (compaction entries are excluded separately). */
const TURN_START_ROLES = new Set(["user", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

/** Preview length per dropped unit in the digest; keeps the digest a digest, not a transcript. */
const PREVIEW_CHARS = 160;

/** Digit padding reserved in the header so its length bound cannot depend on the numbers. */
const HEADER_NUMBER_WORST_CASE = "999999999999";

/**
 * Deterministic digest header. Built from a template so the length bound used by the budget search
 * is computable before the real counts are known.
 */
function renderDigestHeader(droppedCount: number, droppedTokens: number, tokensBefore: number): string {
  return (
    "[deterministic-truncation] Pre-overflow compaction tier 3: the summarizer was unavailable or " +
    `refused, so the engine dropped ${droppedCount} earlier context unit(s) (~${droppedTokens} tokens) ` +
    "to fit the next send. No LLM summary was produced and no new user content was invented; the " +
    `newest turn is preserved verbatim. Truncated from ${tokensBefore} tokens.`
  );
}

/** Worst-case header length: every counter at its widest, so the budget search has a hard bound. */
const MAX_HEADER_CHARS = renderDigestHeader(
  Number(HEADER_NUMBER_WORST_CASE),
  Number(HEADER_NUMBER_WORST_CASE),
  Number(HEADER_NUMBER_WORST_CASE),
).length;

/** The smallest digest budget that can still carry the mandatory truncation label. */
const MIN_LABEL_TOKENS = Math.ceil(MAX_HEADER_CHARS / 4) + 8;

/** Render one projected context message into a single deterministic digest line. */
function renderMessageLine(message: Parameters<typeof estimateTokens>[0]): string {
  const role = (message as { role?: unknown }).role ?? "message";
  const content = (message as { content?: unknown }).content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown; name?: unknown };
      if (p && p.type === "text" && typeof p.text === "string") parts.push(p.text);
      else if (p && p.type === "image") parts.push("[image omitted]");
      else if (p && p.type === "toolCall") parts.push(`[tool call: ${String(p.name ?? "?")}]`);
      else if (p && p.type === "thinking") parts.push("[reasoning omitted]");
    }
    text = parts.join(" ");
  }
  const summary = (message as { summary?: unknown }).summary;
  if (!text && typeof summary === "string") text = summary;
  const collapsed = text.replace(/\s+/g, " ").trim();
  const preview = collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS - 1)}…` : collapsed;
  return `- ${String(role)}: ${preview || "[no text]"}`;
}

/**
 * Assemble the digest, hard-capped to `charCap` UTF-16 units so its token cost
 * (`ceil(length / 4)`, pi's compactionSummary estimator) cannot exceed the budget it was given.
 *
 * Chronological, oldest first. Dropped units are listed by role with a bounded preview; units that
 * project no context text (labels) contribute nothing. When the cap is reached the newest dropped
 * lines are omitted and the omission is stated, so the digest never pretends to be complete.
 */
function buildDigest(dropped: readonly ContextUnit[], charCap: number, tokensBefore: number, droppedTokens: number): string {
  const header = renderDigestHeader(dropped.length, droppedTokens, tokensBefore);
  if (charCap <= header.length) return header;

  const lines: string[] = [];
  let used = header.length;
  let omittedTail = 0;
  for (let i = 0; i < dropped.length; i++) {
    const rendered = dropped[i]!.projected.map(renderMessageLine);
    const blockCost = rendered.reduce((sum, line) => sum + line.length + 1, 0);
    // Reserve room for a closing omission note so the truncation always states itself.
    if (used + blockCost > charCap - 48) {
      omittedTail = dropped.length - i;
      break;
    }
    lines.push(...rendered);
    used += blockCost;
  }

  let digest = `${header}\n\nEarlier context:\n${lines.join("\n")}`;
  if (omittedTail > 0) digest += `\n- [${omittedTail} more dropped unit(s) not listed]`;
  // Belt and braces: the incremental cap should already guarantee this, but the returned plan's
  // token cost is what the caller proves the gate against, so it is enforced here as well.
  if (digest.length > charCap) digest = `${digest.slice(0, Math.max(0, charCap - 1))}…`;
  return digest;
}

function toUnits(activeEntries: readonly SessionEntry[]): ContextUnit[] {
  return activeEntries.map((entry) => {
    const projected = sessionEntryToContextMessages(entry as SessionEntry);
    const tokens = projected.reduce((sum, message) => sum + estimateTokens(message), 0);
    // pi's isTurnStartEntry: a compaction entry is never a turn start, even though its projected
    // compactionSummary message has a turn-start role. Cutting at a compaction entry would leave
    // firstKeptEntryId pointing at an entry the new compaction is meant to supersede.
    const isTurnStart = entry.type !== "compaction" && projected.some((m) => TURN_START_ROLES.has(String((m as { role?: unknown }).role)));
    return { entryId: entry.id, projected, tokens, isTurnStart };
  });
}

/**
 * Choose a deterministic split of the active context that provably fits the message budget.
 *
 * Returns `null` when the caller must refuse honestly: no budget left after the static floor, fewer
 * than two active units, or no turn-start boundary that leaves the mandatory truncation label room
 * (i.e. the newest turn verbatim plus the label is already over the threshold). A `null` result maps
 * to the existing `static-floor` outcome — tier 3 never invents a ninth refusal reason.
 */
export function buildDeterministicFallbackCompaction(
  input: DeterministicFallbackInput,
): DeterministicFallbackPlan | null {
  const { activeEntries, messageTokenBudget, tokensBefore, minSplitIndex = 1 } = input;
  if (!Number.isFinite(messageTokenBudget) || messageTokenBudget <= 0) return null;
  if (activeEntries.length < 2) return null;

  const units = toUnits(activeEntries);

  // Keep the newest turn verbatim: the split may not move past the last turn start.
  let lastStart = -1;
  for (let i = units.length - 1; i >= 0; i--) {
    if (units[i]!.isTurnStart) {
      lastStart = i;
      break;
    }
  }
  const lowerBound = Math.max(1, Math.trunc(minSplitIndex));
  if (lastStart < lowerBound) return null;

  // suffixTokens[i] = message tokens of the kept suffix starting at i.
  const suffixTokens = new Array<number>(units.length + 1).fill(0);
  for (let i = units.length - 1; i >= 0; i--) {
    suffixTokens[i] = suffixTokens[i + 1]! + units[i]!.tokens;
  }
  // A split at i fits only if the mandatory label still has room after the kept suffix.
  const fits = (i: number) => messageTokenBudget - suffixTokens[i]! - 1 >= MIN_LABEL_TOKENS;
  if (!fits(lastStart)) return null;

  // Largest kept suffix == smallest index that fits. `fits` is monotone (kept tokens only shrink as
  // the index grows), so binary-search the boundary, then advance to the next turn start: splits on
  // tool results are forbidden (pi never cuts there — a tool result must follow its tool call).
  let lo = lowerBound;
  let hi = lastStart;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  let split = lo;
  while (split <= lastStart && !units[split]!.isTurnStart) split++;
  if (split > lastStart || !fits(split)) return null;

  const dropped = units.slice(0, split);
  const kept = units.slice(split);
  const keptTokens = suffixTokens[split]!;
  const droppedTokens = suffixTokens[0]! - keptTokens;
  if (keptTokens >= messageTokenBudget - 1 || dropped.length === 0) return null;

  const digestCharCap = (messageTokenBudget - keptTokens - 1) * 4;
  const summary = buildDigest(dropped, digestCharCap, tokensBefore, droppedTokens);
  const digestTokens = Math.ceil(summary.length / 4);

  return {
    summary,
    firstKeptEntryId: units[split]!.entryId,
    tokensBefore,
    droppedEntryCount: dropped.length,
    keptEntryCount: kept.length,
    digestTokens,
    keptTokens,
  };
}
