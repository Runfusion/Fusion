export const TASK_PLAN_WHAT_THIS_DELIVERS_HEADING = "What This Delivers";
export const TASK_PLAN_BEFORE_AFTER_TRANSFORMATION_HEADING = "Before → After Transformation";
export const TASK_PLAN_BEFORE_AFTER_TRANSFORMATION_ASCII_HEADING = "Before -> After Transformation";

export interface TaskPlanSummarySplit {
  summaryMarkdown: string;
  restMarkdown: string;
  hasSummary: boolean;
}

/**
 * FNXC:TaskDetailPlan 2026-08-27-10:22:
 * The Definition tab presents the product summary first so an operator can confirm task intent
 * without reading the full technical plan. The splitter retains every non-blank source line in
 * either the summary or disclosure remainder, so legacy plan detail remains available unchanged.
 */
export function splitTaskPlanSummary(prompt: string): TaskPlanSummarySplit {
  const content = prompt.replace(/^#\s+[^\n]*\n+/, "");
  if (!content) return { summaryMarkdown: "", restMarkdown: "", hasSummary: false };

  const headings = findSummaryHeadings(content);
  if (headings.length === 0) {
    return { summaryMarkdown: "", restMarkdown: content, hasSummary: false };
  }

  const ranges = headings
    .map((heading) => ({
      start: heading.start,
      end: findSectionEnd(content, heading.end),
    }))
    .sort((left, right) => left.start - right.start);

  const summaryMarkdown = ranges
    .map(({ start, end }) => content.slice(start, end).trim())
    .filter(Boolean)
    .join("\n\n");

  let cursor = 0;
  const remainder: string[] = [];
  for (const range of ranges) {
    remainder.push(content.slice(cursor, range.start));
    cursor = range.end;
  }
  remainder.push(content.slice(cursor));

  return {
    summaryMarkdown,
    restMarkdown: normalizeBlankRuns(remainder.join("")),
    hasSummary: summaryMarkdown.trim().length > 0,
  };
}

export interface TaskProductSummary {
  /** Markdown body of the selected section, heading line excluded. */
  markdown: string;
  /** Which plan section supplied it, so a caller can label a legacy fallback. */
  source: "what-this-delivers" | "before-after";
}

/**
 * Select the product-language summary shown above `Read plan` in Task Detail.
 *
 * FNXC:TaskDetailDefinition 2026-09-14-19:45:
 * FN-391 answers "what will this task actually produce?" WITHOUT a second AI call and WITHOUT adding
 * a competing `Summary` section to the plan format. Precedence:
 *   1. `## What This Delivers` — already mandated by the spec-authoring rules as plain product
 *      language with no file paths or symbol names, which is exactly this section's audience;
 *   2. `## Before → After Transformation` — the legacy plans written before that rule existed;
 *   3. nothing — the caller renders a localized placeholder.
 * `## Mission` is DELIBERATELY not a fallback: it is the technical brief the operator said is too
 * technical to read at a glance, so showing it would reintroduce the problem under a friendlier
 * heading. Parsing reuses the fence-aware scanner below, so a heading inside a code fence and a
 * duplicated heading cannot produce a false extraction.
 */
export function extractTaskProductSummary(prompt: string): TaskProductSummary | null {
  const content = prompt.replace(/^#\s+[^\n]*\n+/, "");
  if (!content.trim()) return null;

  for (const kind of ["what", "before-after"] as const) {
    const heading = findSummaryHeadings(content).find((match) => match.kind === kind);
    if (!heading) continue;
    const body = content.slice(heading.end, findSectionEnd(content, heading.end)).trim();
    if (!body) continue;
    return { markdown: body, source: kind === "what" ? "what-this-delivers" : "before-after" };
  }

  return null;
}

/**
 * Extract the body of the plan's `## Before → After Transformation` section.
 *
 * FNXC:TaskDetailDefinition 2026-09-15-16:02:
 * FN-424 promotes the before/after summary to a DIRECT view in Définition, rendered right below
 * `What this delivers` instead of staying buried in the full plan document. It reuses the same
 * fence-aware scanner as `extractTaskProductSummary`, so a heading inside a code fence and a
 * duplicated heading cannot produce a false extraction, and the ASCII `->` variant is accepted.
 * An empty section body is `null` so the caller renders NOTHING rather than an empty shell.
 * Anti-duplication is the CALLER's rule: when `extractTaskProductSummary` already served this same
 * body as its legacy `before-after` fallback, the caller must not render the section twice.
 */
export function extractTaskBeforeAfterTransformation(prompt: string): string | null {
  const content = prompt.replace(/^#\s+[^\n]*\n+/, "");
  if (!content.trim()) return null;

  const heading = findSummaryHeadings(content).find((match) => match.kind === "before-after");
  if (!heading) return null;

  const body = content.slice(heading.end, findSectionEnd(content, heading.end)).trim();
  return body || null;
}

type HeadingMatch = { start: number; end: number; kind: "what" | "before-after" };

function findSummaryHeadings(content: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const found = new Set<string>();
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
      const headingMatch = line.match(/^##\s+(.+?)\s*\r?\n?$/i);
      if (headingMatch) {
        const normalizedHeading = headingMatch[1].trim().toLowerCase();
        const kind = summaryHeadingKind(normalizedHeading);
        if (kind && !found.has(kind)) {
          found.add(kind);
          headings.push({ start: offset, end: offset + line.length, kind });
        }
      }
    }
    offset += line.length;
  }

  return headings;
}

function summaryHeadingKind(heading: string): "what" | "before-after" | null {
  if (heading === TASK_PLAN_WHAT_THIS_DELIVERS_HEADING.toLowerCase()) return "what";
  if (
    heading === TASK_PLAN_BEFORE_AFTER_TRANSFORMATION_HEADING.toLowerCase() ||
    heading === TASK_PLAN_BEFORE_AFTER_TRANSFORMATION_ASCII_HEADING.toLowerCase()
  ) {
    return "before-after";
  }
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

function normalizeBlankRuns(markdown: string): string {
  return markdown.replace(/^\s*\n+|\n+\s*$/g, "").replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, "\n\n");
}
