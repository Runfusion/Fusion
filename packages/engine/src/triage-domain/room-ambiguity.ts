import type { ChatRoomMessage } from "@fusion/core";

export interface DeicticDetectionResult {
  isDeictic: boolean;
  cues: string[];
}

export interface AntecedentCandidate {
  summary: string;
  sourceMessageId: string;
  sourceSenderId: string | null;
  sourceIndexFromEnd: number;
}

export interface ExtractAntecedentOptions {
  maxCandidates?: number;
  lookbackChars?: number;
}

export interface ReferentConfidenceDecision {
  confidence: "high" | "low";
  resolved?: AntecedentCandidate;
  candidates?: AntecedentCandidate[];
}

const CONFIRMATION_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["yes", /\byes\b/i],
  ["yeah", /\byeah\b/i],
  ["yep", /\byep\b/i],
  ["sure", /\bsure\b/i],
  ["ok", /\bok\b/i],
  ["okay", /\bokay\b/i],
  ["do it", /\bdo\s+it\b/i],
  ["go ahead", /\bgo\s+ahead\b/i],
  ["please", /\bplease\b/i],
];

const DEICTIC_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["it", /\bit\b/i],
  ["that", /\bthat\b/i],
  ["this", /\bthis\b/i],
  ["that one", /\bthat\s+one\b/i],
  ["the one", /\bthe\s+one\b/i],
];

const DEICTIC_IMPERATIVE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["create it", /\bcreate\s+it\b/i],
  ["make it", /\bmake\s+it\b/i],
  ["do that", /\bdo\s+that\b/i],
  ["start that", /\bstart\s+that\b/i],
  ["add it", /\badd\s+it\b/i],
  ["file it", /\bfile\s+it\b/i],
];

const PROPOSAL_SUMMARY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:we should|let'?s|lets|could we|please|can we)\s+(?:create|add|file|start|open|track)\s+(.+)/i,
  /\b(?:create|add|file|start|open|track)\s+(.+)/i,
];

const QUOTED_TITLE_PATTERN = /"([^"]{3,120})"|'([^']{3,120})'/g;
const TASK_ID_PATTERN = /\bFN-\d{1,6}\b/gi;
const DEICTIC_NOUN_FOLLOWUP_PATTERN = /\b(?:it|that|this)\s+(?:as|for|to)\b/i;

const DEFAULT_MAX_CANDIDATES = 3;
const DEFAULT_LOOKBACK_CHARS = 1200;
const MAX_MESSAGE_WINDOW = 15;

function normalizeMessageContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function normalizeSummary(summary: string): string {
  return summary
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function truncateSummary(summary: string, max = 140): string {
  if (summary.length <= max) {
    return summary;
  }
  return `${summary.slice(0, max - 1).trimEnd()}…`;
}

function cleanCandidateText(value: string): string {
  return value
    .replace(/^["']+|["']+$/g, "")
    .replace(/^(?:a|an)\s+/i, "")
    .replace(/^(?:follow[-\s]?up|docs?|documentation|flaky[-\s]?test)\s+task\s+(?:for|to)\s+/i, "")
    .replace(/^task\s+(?:for|to)\s+/i, "")
    .replace(/[.?!,;:]+$/g, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

export function detectDeicticReference(content: string): DeicticDetectionResult {
  const normalized = normalizeMessageContent(content);
  if (!normalized || normalized.length > 200) {
    return { isDeictic: false, cues: [] };
  }

  if (DEICTIC_NOUN_FOLLOWUP_PATTERN.test(normalized)) {
    return { isDeictic: false, cues: [] };
  }

  const cues = new Set<string>();

  for (const [cue, pattern] of CONFIRMATION_PATTERNS) {
    if (pattern.test(normalized)) {
      cues.add(cue);
    }
  }

  let hasDeictic = false;
  for (const [cue, pattern] of DEICTIC_PATTERNS) {
    if (pattern.test(normalized)) {
      hasDeictic = true;
      cues.add(cue);
    }
  }

  let hasImperative = false;
  for (const [cue, pattern] of DEICTIC_IMPERATIVE_PATTERNS) {
    if (pattern.test(normalized)) {
      hasImperative = true;
      cues.add(cue);
    }
  }

  const hasConfirmation = CONFIRMATION_PATTERNS.some(([, pattern]) => pattern.test(normalized));
  const isDeictic = hasImperative || (hasConfirmation && hasDeictic);

  return {
    isDeictic,
    cues: isDeictic ? Array.from(cues) : [],
  };
}

function collectSummariesFromMessage(content: string): string[] {
  const summaries: string[] = [];
  const normalized = normalizeMessageContent(content);

  for (const match of normalized.matchAll(TASK_ID_PATTERN)) {
    summaries.push(match[0].toUpperCase());
  }

  for (const pattern of PROPOSAL_SUMMARY_PATTERNS) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      summaries.push(cleanCandidateText(match[1]));
    }
  }

  for (const match of normalized.matchAll(QUOTED_TITLE_PATTERN)) {
    const value = match[1] ?? match[2];
    if (value) {
      summaries.push(cleanCandidateText(value));
    }
  }

  return summaries.map((summary) => truncateSummary(summary)).filter(Boolean);
}

export function extractAntecedentCandidates(
  recentMessages: ChatRoomMessage[],
  opts: ExtractAntecedentOptions = {},
): AntecedentCandidate[] {
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const lookbackChars = opts.lookbackChars ?? DEFAULT_LOOKBACK_CHARS;

  const deduped = new Map<string, AntecedentCandidate>();
  const messageWindow = recentMessages.slice(-MAX_MESSAGE_WINDOW);
  let charsScanned = 0;

  for (let idx = messageWindow.length - 1; idx >= 0; idx -= 1) {
    const message = messageWindow[idx];
    charsScanned += message.content.length;
    const summaries = collectSummariesFromMessage(message.content);
    const sourceIndexFromEnd = messageWindow.length - 1 - idx;

    for (const summary of summaries) {
      const normalizedSummary = normalizeSummary(summary);
      if (!normalizedSummary || deduped.has(normalizedSummary)) {
        continue;
      }
      deduped.set(normalizedSummary, {
        summary,
        sourceMessageId: message.id,
        sourceSenderId: message.senderAgentId,
        sourceIndexFromEnd,
      });
    }

    if (deduped.size >= maxCandidates || charsScanned >= lookbackChars) {
      break;
    }
  }

  return Array.from(deduped.values()).slice(0, maxCandidates);
}

export function scoreReferentConfidence(candidates: AntecedentCandidate[]): ReferentConfidenceDecision {
  if (candidates.length !== 1) {
    return { confidence: "low", candidates };
  }

  const resolved = candidates[0];
  if (resolved.sourceIndexFromEnd <= 4) {
    return { confidence: "high", resolved, candidates };
  }

  return { confidence: "low", candidates };
}

export function renderAmbiguityPromptBlock(
  decision: ReferentConfidenceDecision,
  deicticMessage: Pick<ChatRoomMessage, "id">,
): string[] {
  if (decision.confidence === "high" && decision.resolved) {
    return [
      `Resolved Referent: ${decision.resolved.summary} (from message ${decision.resolved.sourceMessageId} by ${decision.resolved.sourceSenderId ?? "unknown"}). Before calling fn_task_create or fn_post_room_message, echo this exact subject in your reply so a human can correct it.`,
    ];
  }

  const lowConfidenceLines = [
    "Do NOT create a task or spawn work. Reply once with fn_post_room_message asking which referent applies, and include the inferred options below.",
  ];

  for (const [index, candidate] of (decision.candidates ?? []).slice(0, 3).entries()) {
    lowConfidenceLines.push(
      `${index + 1}. ${candidate.summary} (from message ${candidate.sourceMessageId} by ${candidate.sourceSenderId ?? "unknown"})`,
    );
  }

  lowConfidenceLines.push(`Use reply_to_message_id = ${deicticMessage.id}.`);
  return lowConfidenceLines;
}
