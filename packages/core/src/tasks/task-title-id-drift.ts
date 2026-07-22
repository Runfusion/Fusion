import { MAX_TITLE_LENGTH } from "../ai/ai-summarize.js";

export const TASK_ID_TOKEN_RE = /\bFN-(\d+)\b/gi;

const CONNECTOR_RE = /[:\-—–]/;
const EMPTY_PLACEHOLDER_CONTENT_RE = /^[\s,:;\-—–.!?]*$/;

export const DANGLING_TAIL_STOPWORDS = new Set([
  "of", "for", "to", "from", "as", "in", "on", "with", "by", "and", "or", "the", "a", "an", "at", "into", "onto",
  "about", "via", "per", "vs",
]);

export function stripDanglingTail(text: string): string {
  let normalized = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const words = normalized.split(/\s+/).filter(Boolean);
    const tail = words.at(-1)?.toLowerCase();
    if (!tail || !DANGLING_TAIL_STOPWORDS.has(tail)) {
      break;
    }
    words.pop();
    normalized = stripEmptyPlaceholders(words.join(" "));
    if (!normalized) {
      break;
    }
  }
  return normalized;
}

export function stripEmptyPlaceholders(text: string): string {
  let normalized = text;

  // Remove empty bracketed placeholders ((), [], {}) that contain only
  // whitespace or punctuation residue/connectors.
  normalized = normalized.replace(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g, (match, paren, square, brace) => {
    const content = (paren ?? square ?? brace ?? "").trim();
    return EMPTY_PLACEHOLDER_CONTENT_RE.test(content) ? " " : match;
  });

  normalized = normalized
    .replace(/\s+([,:;.!?])/g, "$1")
    .replace(/([:\-—–])\s*(?=[:\-—–])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  normalized = normalized
    .replace(new RegExp(`(?:\\s*${CONNECTOR_RE.source}\\s*)+$`), "")
    .replace(/[,:;.!?]+$/g, "")
    .trim();

  return normalized;
}

export function extractTaskIdTokens(title: string): string[] {
  const tokens = new Set<string>();
  for (const match of title.matchAll(TASK_ID_TOKEN_RE)) {
    const raw = match[0];
    if (raw) {
      tokens.add(raw.toUpperCase());
    }
  }
  return [...tokens];
}

export function hasTitleIdDrift(title: string | undefined | null, rowId: string): boolean {
  if (!title) return false;
  const tokens = extractTaskIdTokens(title);
  if (tokens.length === 0) return false;
  const normalizedRowId = rowId.toUpperCase();
  return !tokens.some((token) => token === normalizedRowId);
}

export function normalizeTitleForTaskId(
  title: string | undefined | null,
  rowId: string,
): { title: string | null; changed: boolean } {
  const initial = title ?? null;
  if (initial === null || initial.length === 0) {
    return { title: initial, changed: false };
  }
  if (!hasTitleIdDrift(initial, rowId)) {
    return { title: initial, changed: false };
  }

  let normalized = initial.replace(/\bFN-\d+\b\s*([:\-—–])?\s*/gi, " ");
  normalized = stripEmptyPlaceholders(normalized);
  const beforeDanglingTail = normalized;
  const beforeTail = beforeDanglingTail.split(/\s+/).filter(Boolean).at(-1)?.toLowerCase();
  const hadDanglingStopwordTail = Boolean(beforeTail && DANGLING_TAIL_STOPWORDS.has(beforeTail));
  normalized = stripDanglingTail(normalized);

  if (normalized.length > MAX_TITLE_LENGTH) {
    normalized = normalized.slice(0, MAX_TITLE_LENGTH).trim();
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const nextTitle =
    normalized.length === 0
      ? null
      : hadDanglingStopwordTail && normalized !== beforeDanglingTail
        ? null
        : /^close\s+as\s+duplicate(?:\s+of)?$/i.test(normalized)
          ? null
          : words.length === 1 && DANGLING_TAIL_STOPWORDS.has(words[0]!.toLowerCase())
            ? null
            : normalized;
  return { title: nextTitle, changed: nextTitle !== initial };
}
