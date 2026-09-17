import type { TFunction } from "i18next";
import type { Message, MessageMetadata } from "@fusion/core";

/*
FNXC:MailboxSubject 2026-09-15-04:40:
Operator requirement: every mailbox row must show an AUTHOR and a SUBJECT, never the raw head of the
body. Before this resolver a completion notice rendered literally as "## Task completed: FN-325".

This is the single source of mailbox subjects for every surface (MailboxView, MailboxModal and the
AgentDetailView Mail tab). Precedence, highest first:
  1. `metadata.subject` written by the author           -> source "explicit"
  2. a localized subject derived from `metadata.kind`   -> source "kind"
  3. the report title of a structural report mail       -> source "report"
  4. the first meaningful body line, Markdown-stripped  -> source "content"
  5. the "(no subject)" fallback label                  -> source "fallback"
A kind whose localized subject needs data that is absent (task id, proposal title) never fabricates
a subject: it falls through to rule 4 so nothing is invented.

Legacy persisted rows carry no `subject`, so derivation (rules 2-4) is what keeps the promise true
for mail that was already stored before the field existed.
*/

export type MailboxSubjectSource = "explicit" | "kind" | "report" | "content" | "fallback";

export interface ResolvedMailboxSubject {
  /** Short, Markdown-free subject line. Never empty. */
  subject: string;
  /** Which precedence rule produced the subject. */
  source: MailboxSubjectSource;
  /** Optional one-line body preview; empty means "render no preview element at all". */
  bodyPreview: string;
}

const PREVIEW_MAX = 80;
const SUBJECT_MAX = 80;

/** Truncate to a single-line display length with an ellipsis. */
function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Remove leading block markers and inline emphasis/code markers from one line. */
export function stripMarkdownMarkers(line: string): string {
  let out = line.trim();

  // Leading block markers can nest, e.g. "> ## Title" or "- **Item**".
  let previous = "";
  while (out !== previous) {
    previous = out;
    out = out.replace(/^\s*(?:#{1,6}|>+|[-*+])\s+/, "").replace(/^\s*(?:#{1,6}|>+)\s*/, "");
  }

  out = out.replace(/`+/g, "");
  out = out.replace(/\*\*(.*?)\*\*/g, "$1");
  out = out.replace(/__(.*?)__/g, "$1");
  out = out.replace(/\*(.*?)\*/g, "$1");
  out = out.replace(/(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])/g, "$1");
  out = out.replace(/\*\*|__|\*/g, "");
  out = out.replace(/\s*#+\s*$/, "");

  // A line made of Markdown punctuation only (bare bullet, horizontal rule, empty quote) carries no text.
  if (/^[#>*_`+\-\s]*$/.test(out)) return "";

  return out.trim();
}

interface BodyLine {
  raw: string;
  clean: string;
}

/** Meaningful body lines, in order, with their Markdown-stripped rendering. */
function meaningfulLines(content: string): BodyLine[] {
  return content
    .split("\n")
    .map((raw) => ({ raw, clean: stripMarkdownMarkers(raw) }))
    .filter((line) => line.clean.length > 0);
}

function isHeadingLine(raw: string): boolean {
  return /^\s*#{1,6}\s+/.test(raw);
}

/** Localized subject for a known system notice kind, or null when data is missing/unknown. */
function subjectFromKind(metadata: MessageMetadata | undefined, t: TFunction<"app">): string | null {
  const kind = typeof metadata?.kind === "string" ? metadata.kind : undefined;
  if (!kind) return null;

  const taskId = typeof metadata?.taskId === "string" && metadata.taskId.trim() ? metadata.taskId.trim() : undefined;

  switch (kind) {
    case "task-completion-notice":
      return taskId ? t("mailbox.subject.taskCompleted", "{{taskId}} completed", { taskId }) : null;
    case "task-proposal": {
      const title = typeof metadata?.proposedTask?.title === "string" ? metadata.proposedTask.title.trim() : "";
      return title ? t("mailbox.subject.taskProposal", "Task proposal: {{title}}", { title }) : null;
    }
    case "task-recommendation-notice":
      return t("mailbox.subject.taskRecommendations", "Task recommendations");
    case "task-wedge":
      return taskId ? t("mailbox.subject.taskWedge", "{{taskId}} needs attention", { taskId }) : null;
    case "triage-duplicate-decision":
      return taskId ? t("mailbox.subject.duplicateDecision", "{{taskId}} duplicate decision", { taskId }) : null;
    case "planning-clarification":
      return t("mailbox.subject.planningClarification", "Planning clarification");
    default:
      return null;
  }
}

/**
 * Resolve the display subject and body preview of one mailbox message.
 *
 * @param message message (or any record carrying `content` and `metadata`)
 * @param t translation function of the `app` namespace
 */
export function resolveMailboxMessageSubject(
  message: Pick<Message, "content" | "metadata">,
  t: TFunction<"app">,
): ResolvedMailboxSubject {
  const metadata = message.metadata;
  const lines = meaningfulLines(message.content ?? "");

  const explicit = typeof metadata?.subject === "string" ? metadata.subject.trim() : "";
  const kindSubject = explicit ? null : subjectFromKind(metadata, t);
  const reportTitle =
    !explicit && !kindSubject && metadata?.mailKind === "report" && typeof metadata.report?.title === "string"
      ? metadata.report.title.trim()
      : "";

  if (explicit || kindSubject || reportTitle) {
    /*
    FNXC:MailboxSubject 2026-09-15-04:40:
    When the subject does not come from the body, the body's own leading Markdown title (e.g.
    "## Task completed: FN-325") is already represented by the subject, so the preview starts at the
    next meaningful line instead of echoing the title back with its markers.
    */
    const previewLine = lines.length > 0 && isHeadingLine(lines[0].raw) ? lines[1] : lines[0];
    const bodyPreview = previewLine ? clamp(previewLine.clean, PREVIEW_MAX) : "";
    if (explicit) return { subject: clamp(explicit, SUBJECT_MAX), source: "explicit", bodyPreview };
    if (kindSubject) return { subject: clamp(kindSubject, SUBJECT_MAX), source: "kind", bodyPreview };
    return { subject: clamp(reportTitle, SUBJECT_MAX), source: "report", bodyPreview };
  }

  if (lines.length > 0) {
    const [first, ...rest] = lines;
    const bodyPreview = rest.length > 0 ? clamp(rest[0].clean, PREVIEW_MAX) : "";
    return { subject: clamp(first.clean, SUBJECT_MAX), source: "content", bodyPreview };
  }

  return { subject: t("mailbox.subject.none", "(no subject)"), source: "fallback", bodyPreview: "" };
}
