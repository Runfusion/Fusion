import type { RecallSearchHit } from "./recall-types.js";

/*
FNXC:MemoryRecall 2026-08-10-11:03:
This mirrors engine agent-memory-index's UTF-8 clamp. The 800-byte budget covers only the complete
recall section appended to a prompt, including its heading, lines, separator, and trailing newline;
it never truncates pre-existing prompt instructions.
*/
export const MAX_RECALL_INJECTION_BYTES = 800;
const RECALL_LINE_MAX_BYTES = 360;

/** Clamp on code points so UTF-8 characters are never split. */
function clampUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

function formatRecallInstructionSectionWithinBudget(
  hits: readonly RecallSearchHit[],
  maxBytes: number,
): string {
  if (!hits.length || maxBytes <= 0) return "";
  const lines = ["### Recalled Context"];
  for (const hit of hits) {
    const line = clampUtf8(`- [${hit.record.kind}] ${hit.record.content.trim()}`, RECALL_LINE_MAX_BYTES);
    const proposed = `${lines.join("\n")}\n${line}\n`;
    if (Buffer.byteLength(proposed, "utf8") > maxBytes) break;
    lines.push(line);
  }
  // Do not inject a heading with no usable recalled content.
  return lines.length === 1 ? "" : `${lines.join("\n")}\n`;
}

/** Render a standalone recall section within the recall-only byte budget. */
export function formatRecallInstructionSection(hits: readonly RecallSearchHit[]): string {
  return formatRecallInstructionSectionWithinBudget(hits, MAX_RECALL_INJECTION_BYTES);
}

/**
 * Append recall without charging its separator to existing instructions.
 * The section formatter receives the remaining budget, so the complete appended delta is bounded.
 */
export function appendRecallInstructionSection(
  instructions: string,
  hits?: readonly RecallSearchHit[],
): string {
  if (!instructions || !hits?.length) return instructions;
  const separator = instructions.endsWith("\n") ? "\n" : "\n\n";
  const section = formatRecallInstructionSectionWithinBudget(
    hits,
    MAX_RECALL_INJECTION_BYTES - Buffer.byteLength(separator, "utf8"),
  );
  return section ? `${instructions}${separator}${section}` : instructions;
}
