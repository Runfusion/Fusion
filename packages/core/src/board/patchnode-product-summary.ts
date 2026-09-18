/**
 * Exact number of characters of the plan's product summary kept as a ledger body.
 *
 * FNXC:PatchnodeLedger 2026-09-18-02:48:
 * FN-526 mirrors the `PATCHNODE_DESCRIPTION_LABEL_LENGTH` rule: the first 400 characters taken
 * EXACTLY, with no ellipsis, suffix, or word-boundary rounding, because the History card renders a
 * single plain-text line and a cosmetic suffix would become durable ledger content.
 */
export const PATCHNODE_PRODUCT_SUMMARY_LENGTH = 400;

const WHAT_THIS_DELIVERS_HEADING = "what this delivers";
const BEFORE_AFTER_HEADINGS = ["before → after transformation", "before -> after transformation"];

type HeadingKind = "what" | "before-after";
type HeadingMatch = { end: number; kind: HeadingKind };

/**
 * Plain-text product summary of a task plan, for the durable Patchnode ledger body.
 *
 * FNXC:PatchnodeLedger 2026-09-18-02:48:
 * FN-526 moves the History description AWAY from `task.summary` (the Completion Summary, a technical
 * end-of-run report) onto the plan's product-language summary, which is what the operator actually
 * wants to re-read under a delivery. Precedence mirrors the dashboard's `extractTaskProductSummary`:
 *   1. `## What This Delivers` — mandated by the spec-authoring rules as plain product language;
 *   2. `## Before → After Transformation` (and its ASCII `->` variant) — legacy plans;
 *   3. nothing — an EMPTY body, never a Completion Summary fallback. That absence is the operator's
 *      explicit request: a delivery with no product section shows no description line at all.
 * `## Mission` is DELIBERATELY not a fallback: it is the technical brief the operator said is too
 * technical to read at a glance, so surfacing it would reintroduce the reported problem.
 *
 * The rule is DUPLICATED rather than imported from `packages/dashboard/app/utils/taskPlanSummary.ts`
 * for the same reason as `buildPatchnodeSnapshotLabel`: `@fusion/core` cannot depend on the dashboard
 * package, and the dashboard's browser bundle aliases `@fusion/core` to `types.ts`, so neither side
 * can import the other's runtime helper. Convergence is pinned by tests on both sides.
 *
 * The module is PURE — no `fs`, no dashboard import — so `types.ts` can never inherit a filesystem
 * dependency through it. Reading `PROMPT.md` is the caller's job.
 */
export function extractPatchnodeProductSummary(prompt: string | null | undefined): string {
  if (typeof prompt !== "string") return "";
  const content = prompt.replace(/^#\s+[^\n]*\n+/, "");
  if (!content.trim()) return "";

  const headings = findSummaryHeadings(content);
  for (const kind of ["what", "before-after"] as const) {
    const heading = headings.find((match) => match.kind === kind);
    if (!heading) continue;
    const body = content.slice(heading.end, findSectionEnd(content, heading.end)).trim();
    if (!body) continue;
    const flattened = flattenToPlainLine(body);
    if (flattened) return flattened.slice(0, PATCHNODE_PRODUCT_SUMMARY_LENGTH);
  }

  return "";
}

/**
 * FNXC:PatchnodeLedger 2026-09-18-02:48:
 * The History card renders one plain-text line, so the markdown bullet list the product section is
 * usually written as must be flattened: blank lines dropped, leading list markers and heading
 * hashes removed, `**` and backticks stripped, lines joined by a single space.
 */
function flattenToPlainLine(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*+]|\d+\.)\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fence-aware scan for the first occurrence of each product heading.
 *
 * FNXC:PatchnodeLedger 2026-09-18-02:48:
 * A heading inside a ``` or ~~~ fence is sample text, not a section, and a duplicated heading must
 * not produce a second extraction — mirrors the dashboard scanner exactly.
 */
function findSummaryHeadings(content: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const found = new Set<HeadingKind>();
  let offset = 0;
  let fence: "`" | "~" | null = null;

  for (const line of content.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
    } else if (!fence) {
      const headingMatch = line.match(/^##\s+(.+?)\s*\r?\n?$/);
      if (headingMatch) {
        const kind = summaryHeadingKind(headingMatch[1].trim().toLowerCase());
        if (kind && !found.has(kind)) {
          found.add(kind);
          headings.push({ end: offset + line.length, kind });
        }
      }
    }
    offset += line.length;
  }

  return headings;
}

function summaryHeadingKind(heading: string): HeadingKind | null {
  if (heading === WHAT_THIS_DELIVERS_HEADING) return "what";
  if (BEFORE_AFTER_HEADINGS.includes(heading)) return "before-after";
  return null;
}

function findSectionEnd(content: string, start: number): number {
  let offset = start;
  let fence: "`" | "~" | null = null;

  for (const line of content.slice(start).split(/(?<=\n)/)) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
    } else if (!fence && /^#{1,2}(?:\s|$)/.test(line)) {
      return offset;
    }
    offset += line.length;
  }

  return content.length;
}
