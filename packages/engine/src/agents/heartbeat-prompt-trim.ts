import type { HeartbeatPromptTemplate } from "@fusion/core";

const TASK_DESC_CAP: Record<HeartbeatPromptTemplate, number> = {
  default: 800,
  compact: 400,
};
const PROMPT_MD_CAP: Record<HeartbeatPromptTemplate, number> = {
  default: 4000,
  compact: 1500,
};
const TASK_TRUNCATION_MARKER = "… (truncated, use fn_task_show for full)";
const COMMENTS_TRUNCATION_MARKER = "… (older comments hidden, fetch via fn_task_show)";

function truncate(value: string, cap: number, marker: string): string {
  if (value.length <= cap) {
    return value;
  }
  const sliceLength = Math.max(0, cap - marker.length);
  return `${value.slice(0, sliceLength)}${marker}`;
}

export function trimTaskDescription(description: string, template: HeartbeatPromptTemplate): string {
  return truncate(description, TASK_DESC_CAP[template], TASK_TRUNCATION_MARKER);
}

export function trimPromptMd(prompt: string | undefined, template: HeartbeatPromptTemplate): string | undefined {
  if (prompt === undefined) {
    return undefined;
  }
  return truncate(prompt, PROMPT_MD_CAP[template], TASK_TRUNCATION_MARKER);
}

const TRIGGERING_COMMENT_HEADING = "New comments since last run:";

export function trimTriggeringComments(lines: string[], _template: HeartbeatPromptTemplate): string[] {
  const headingIndex = lines.indexOf(TRIGGERING_COMMENT_HEADING);
  const headings = headingIndex >= 0 ? lines.slice(0, headingIndex + 1) : [];
  const body = headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines;

  if (body.length <= 3) {
    return lines;
  }

  const selected = body.slice(-3);
  const joined = selected.join("\n");
  if (joined.length <= 500) {
    return [...headings, ...selected];
  }
  const truncated = truncate(joined, 500, COMMENTS_TRUNCATION_MARKER);
  return [...headings, ...truncated.split("\n")];
}
