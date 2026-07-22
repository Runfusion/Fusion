import { createHash } from "node:crypto";

import type { Column, ColumnId } from "../types.js";

export interface DuplicateMatch {
  id: string;
  title: string;
  description: string;
  column: ColumnId;
  score: number;
}

export interface DuplicateMatchInput {
  title?: string;
  description: string;
}

export interface DuplicateCandidate {
  id: string;
  title: string;
  description: string;
  column: ColumnId;
}

export interface ContentFingerprintInput {
  title?: string | null;
  description: string;
}

const DEFAULT_THRESHOLD = 0.45;
const DEFAULT_LIMIT = 5;
const DEFAULT_EXCLUDE_COLUMNS: Column[] = ["done", "archived"];
export const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "for",
  "in",
  "is",
  "on",
  "with",
  "fn",
]);

function normalizeFingerprintPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[,.;:!?"'`(){}]+/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/…$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic dedup fingerprint for task content.
 */
export function computeContentFingerprint(
  input: ContentFingerprintInput,
): string | null {
  const normalizedDescription = normalizeFingerprintPart(input.description);
  if (normalizedDescription.length === 0) {
    return null;
  }

  const normalizedTitle = normalizeFingerprintPart(input.title ?? "");
  return createHash("sha256")
    .update(`${normalizedTitle}\n${normalizedDescription}`)
    .digest("hex");
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\W+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function toTrigrams(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length < 3) {
    return new Set();
  }
  const trigrams = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    trigrams.add(normalized.slice(index, index + 3));
  }
  return trigrams;
}

function jaccardScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersectionCount = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersectionCount += 1;
    }
  }
  const unionCount = left.size + right.size - intersectionCount;
  return unionCount > 0 ? intersectionCount / unionCount : 0;
}

function hasTitleTrigramOverlap(left: string, right: string): boolean {
  const leftTrigrams = toTrigrams(left);
  const rightTrigrams = toTrigrams(right);
  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) {
    return false;
  }
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) {
      return true;
    }
  }
  return false;
}

export function findDuplicateMatches(
  input: DuplicateMatchInput,
  candidates: DuplicateCandidate[],
  opts?: {
    threshold?: number;
    limit?: number;
    excludeColumns?: Column[];
  },
): DuplicateMatch[] {
  const description = input.description.trim();
  if (description.length === 0) {
    return [];
  }

  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const excludedColumns = new Set<ColumnId>(opts?.excludeColumns ?? DEFAULT_EXCLUDE_COLUMNS);
  const sourceText = `${input.title ?? ""} ${description}`.trim();
  const sourceTokens = new Set(tokenize(sourceText));
  const sourceTitle = input.title ?? "";
  const sourceTitleTokens = new Set(tokenize(sourceTitle));

  const matches: DuplicateMatch[] = [];
  for (const candidate of candidates) {
    if (excludedColumns.has(candidate.column)) {
      continue;
    }

    const candidateText = `${candidate.title} ${candidate.description}`.trim();
    const candidateTokens = new Set(tokenize(candidateText));
    const candidateTitleTokens = new Set(tokenize(candidate.title));
    const contentScore = jaccardScore(sourceTokens, candidateTokens);
    const titleScore = jaccardScore(sourceTitleTokens, candidateTitleTokens);
    let score = Math.max(contentScore, contentScore * 0.7 + titleScore * 0.3);

    if (hasTitleTrigramOverlap(sourceTitle, candidate.title)) {
      score += 0.05;
    }

    if (score >= threshold) {
      matches.push({
        id: candidate.id,
        title: candidate.title,
        description: candidate.description,
        column: candidate.column,
        score,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}
