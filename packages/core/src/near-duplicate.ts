import { STOPWORDS, tokenize } from "./duplicate-detection.js";
import type { ColumnId } from "./types.js";

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SHARED_TOKENS = 2;
const DEFAULT_TITLE_THRESHOLD = 0.3;
const GENERIC_LARGE_FILE_TITLE_THRESHOLD = 0.5;
const MAX_TOKENS_PER_BUCKET = 32;

// FN-5152: frequently touched broad files should not trigger near-duplicate matches by themselves.
const GENERIC_LARGE_FILES = new Set([
  "register-git-github.ts",
  "register-task-workflow-routes.ts",
  "store.ts",
  "types.ts",
  "styles.css",
]);

export interface IntentSignature {
  routePaths: string[];
  filePaths: string[];
  identifiers: string[];
  titleTokens: string[];
}

export interface NearDuplicateInput {
  title?: string | null;
  description: string;
  fileScope?: string[];
}

export interface NearDuplicateCandidate {
  id: string;
  title: string;
  description: string;
  column: ColumnId;
  fileScope?: string[];
  createdAt?: number;
}

export { isActiveNearDuplicateColumn, isNearDuplicateCanonicalInactive } from "./near-duplicate-canonical.js";
export type { NearDuplicateCanonicalState } from "./near-duplicate-canonical.js";

export interface NearDuplicateMatch {
  id: string;
  score: number;
  sharedTokens: string[];
  titleScore: number;
  reason: "near-duplicate-intent";
}

interface SignalToken {
  token: string;
  kind: "route" | "file" | "identifier";
}

function toUnique(values: string[], limit = MAX_TOKENS_PER_BUCKET): string[] {
  return Array.from(new Set(values)).slice(0, limit);
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function extractRoutePaths(text: string): string[] {
  const matches = text.match(/\/[a-z][\w/:.-]+(?:\/[\w:.-]+)+/gi) ?? [];
  const expanded: string[] = [];
  for (const match of matches) {
    const lower = match.toLowerCase();
    expanded.push(lower);
    const prTail = lower.match(/\/pr\/[\w:.-]+(?:\/[\w:.-]+)*/g);
    if (prTail) {
      expanded.push(...prTail);
    }
  }
  const filtered = expanded
    .filter((entry) => /\/[\w:.-]+\/[\w:.-]+/.test(entry))
    .filter((entry) => /\b(pr|api|tasks|users|repos|reviews|merge|settings|workflow)\b/.test(entry));
  return toUnique(filtered);
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(/(?:packages|app|scripts|docs|tests?)\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs|css|md|json)/g) ?? [];
  return toUnique(matches.map((entry) => entry.toLowerCase()));
}

function extractIdentifiers(text: string): string[] {
  const backticked = Array.from(text.matchAll(/`([^`]+)`/g)).map((match) => match[1]?.trim() ?? "");
  const codeShaped = text.match(/\b(?:[A-Z][A-Za-z0-9]+[A-Z][A-Za-z0-9]*|[a-z0-9]+_[a-z0-9_]+|[a-z0-9]+(?:-[a-z0-9]+)+(?:\.[a-z0-9]+)?|[a-z]+[A-Z][A-Za-z0-9]*)\b/g) ?? [];
  const raw = [...backticked, ...codeShaped];
  const filtered = raw
    .map((value) => value.trim())
    .filter((value) => value.length >= 4)
    .filter((value) => !STOPWORDS.has(value.toLowerCase()))
    .map((value) => value.toLowerCase());
  return toUnique(filtered);
}

export function extractIntentSignature(input: NearDuplicateInput): IntentSignature {
  const title = input.title ?? "";
  const fileScope = input.fileScope ?? [];
  const text = `${title}\n${input.description}\n${fileScope.join("\n")}`;
  return {
    routePaths: extractRoutePaths(text),
    filePaths: extractFilePaths(text),
    identifiers: extractIdentifiers(text),
    titleTokens: toUnique(tokenize(title).filter((token) => token.length >= 3)),
  };
}

function getSignalTokens(signature: IntentSignature): SignalToken[] {
  return [
    ...signature.routePaths.map((token) => ({ token, kind: "route" as const })),
    ...signature.filePaths.map((token) => ({ token, kind: "file" as const })),
    ...signature.identifiers.map((token) => ({ token, kind: "identifier" as const })),
  ];
}

export function findNearDuplicates(
  input: NearDuplicateInput,
  candidates: NearDuplicateCandidate[],
  opts?: {
    minSharedTokens?: number;
    titleThreshold?: number;
    windowMs?: number;
    nowMs?: number;
    limit?: number;
  },
): NearDuplicateMatch[] {
  const source = extractIntentSignature(input);
  const sourceSignals = getSignalTokens(source);
  if (sourceSignals.length === 0) {
    return [];
  }

  const minSharedTokens = opts?.minSharedTokens ?? DEFAULT_MIN_SHARED_TOKENS;
  const titleThreshold = opts?.titleThreshold ?? DEFAULT_TITLE_THRESHOLD;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoff = nowMs - windowMs;
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const matches: NearDuplicateMatch[] = [];

  for (const candidate of candidates) {
    if (candidate.createdAt != null && candidate.createdAt < cutoff) {
      continue;
    }

    const candidateSignature = extractIntentSignature({
      title: candidate.title,
      description: candidate.description,
      fileScope: candidate.fileScope,
    });
    const candidateSignals = getSignalTokens(candidateSignature);
    if (candidateSignals.length === 0) {
      continue;
    }

    const candidateTokenKinds = new Map(candidateSignals.map((entry) => [entry.token, entry.kind]));
    const sharedTokens = toUnique(sourceSignals
      .filter((entry) => candidateTokenKinds.has(entry.token))
      .map((entry) => entry.token), 256);

    const titleScore = jaccard(source.titleTokens, candidateSignature.titleTokens);

    const sharedFileTokens = sharedTokens.filter((token) => candidateTokenKinds.get(token) === "file");
    const allSharedAreFiles = sharedFileTokens.length === sharedTokens.length;
    const allSharedAreGenericLargeFiles =
      sharedFileTokens.length > 0 &&
      sharedFileTokens.every((token) => GENERIC_LARGE_FILES.has(token.split("/").pop() ?? token));
    const effectiveTitleThreshold =
      allSharedAreFiles && allSharedAreGenericLargeFiles
        ? Math.max(titleThreshold, GENERIC_LARGE_FILE_TITLE_THRESHOLD)
        : titleThreshold;

    if (sharedTokens.length < minSharedTokens || titleScore < effectiveTitleThreshold) {
      continue;
    }

    const signalDenominator = Math.max(sourceSignals.length, candidateSignals.length, 1);
    const score =
      0.5 * (sharedTokens.length / signalDenominator) + 0.5 * titleScore;

    matches.push({
      id: candidate.id,
      score,
      sharedTokens,
      titleScore,
      reason: "near-duplicate-intent",
    });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}
