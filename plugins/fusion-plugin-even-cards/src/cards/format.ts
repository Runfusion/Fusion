import type { CardStatusBadge, FusionColumn } from "./types.js";

export const DEFAULT_MAX_CHARS_PER_LINE = 24;
export const DEFAULT_MAX_LINES_PER_CARD = 4;
export const DEFAULT_MAX_CARDS_PER_DECK = 8;

export function truncateLine(input: string, max: number): string {
  const value = input.trim();
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

export function wrapLines(text: string, max: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      if (lines.length === maxLines) return lines.map((line, idx) => (idx === maxLines - 1 ? truncateLine(line, max) : line));
    }
    current = word.length <= max ? word : truncateLine(word, max);
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines.slice(0, maxLines).map((line, idx, arr) => (idx === arr.length - 1 ? truncateLine(line, max) : line));
}

export function statusBadge(column: FusionColumn): CardStatusBadge {
  switch (column) {
    case "triage":
    case "todo":
    case "in-progress":
    case "in-review":
    case "done":
      return { label: column, tone: column };
    case "archived":
    default:
      return { label: column, tone: "neutral" };
  }
}

export function formatTaskId(id: string): string {
  return id.trim().toUpperCase();
}

export function formatRelativeAge(createdAtIso: string, nowIso: string): string {
  const created = Date.parse(createdAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(created) || !Number.isFinite(now) || now <= created) return "0m";

  const diffMs = now - created;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
