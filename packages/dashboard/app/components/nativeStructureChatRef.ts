import type { NativeStructureRef } from "@fusion/core";

const NATIVE_STRUCTURE_KINDS = [
  "mission",
  "milestone",
  "roadmap-item",
  "research-finding",
  "eval-result",
  "goal",
] as const;

type NativeStructureChatKind = (typeof NATIVE_STRUCTURE_KINDS)[number];

const nativeStructureKindsPattern = NATIVE_STRUCTURE_KINDS.join("|");
const canonicalRefPattern = new RegExp(`^fusion://(${nativeStructureKindsPattern})/([^/?#\\s]+)$`);
const trailingProsePunctuationPattern = /[.,!?;:]+$/;

/**
 * FNXC:NativeStructureEmbed 2026-07-19-19:30:
 * Chat references use the explicit `fusion://<kind>/<id>` form instead of free-text matching so
 * ordinary prose cannot accidentally fetch or expose a native structure. This matcher finds only
 * complete bare tokens in surrounding text; every candidate is still validated by the parser.
 */
export const nativeStructureChatRefMatcher = new RegExp(
  `(?<![A-Za-z0-9_-])(fusion://(?:${nativeStructureKindsPattern})/[A-Za-z0-9][A-Za-z0-9._:-]*?)([.,!?;:]*)?(?=$|[\\s<>()\\[\\]{}])`,
  "g",
);

/** Returns the canonical token and only terminal prose punctuation consumed by the bare-token matcher. */
export function splitNativeStructureChatRefMatch(match: RegExpMatchArray): { token: string; trailingPunctuation: string } {
  return { token: match[1] ?? match[0].replace(trailingProsePunctuationPattern, ""), trailingPunctuation: match[2] ?? "" };
}

/**
 * FNXC:NativeStructureEmbed 2026-07-19-19:30:
 * One strict parser is shared by assistant Markdown links, assistant text nodes, and raw user
 * messages. Encoded path separators and extra segments are rejected so a display token cannot
 * resolve a structure other than the one it visibly names.
 */
export function parseNativeStructureChatRef(hrefOrToken: string): NativeStructureRef | null {
  const match = canonicalRefPattern.exec(hrefOrToken);
  if (!match) return null;

  const [, kind, id] = match;
  if (!kind || !id || /%2f|%5c/i.test(id)) return null;

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(id);
  } catch {
    return null;
  }
  if (!decodedId.trim() || decodedId !== id || /[\\/]/.test(decodedId)) return null;

  // FNXC:NativeStructureEmbed 2026-07-19-20:10: `roadmap-item` intentionally reaches the shared
  // unavailable renderer until its adapter lands; retain the core ref contract rather than fork it here.
  return { kind: kind as NativeStructureChatKind, id } as NativeStructureRef;
}
