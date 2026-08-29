import type { Report } from "./store/report-types.js";

const MAX_ITEMS_PER_SECTION = 5;
const MAX_BLOCK_LENGTH = 1500;

export interface ShareBlocks {
  plainText: string;
  markdown: string;
  slack: string;
  emailHtml: string;
}

function sliceWithEllipsis(items: string[]): string[] {
  if (items.length <= MAX_ITEMS_PER_SECTION) return items;
  return [...items.slice(0, MAX_ITEMS_PER_SECTION), "…"];
}

function getSections(report: Report): Array<{ heading: string; items: string[] }> {
  const review = report.combinedReview;
  const sections: Array<{ heading: string; items: string[] }> = [];
  const wins = review?.mergedHighlights ?? [];
  const highlights = review?.mergedSuggestions ?? [];
  const lowlights = review?.mergedLowlights ?? [];
  if (wins.length > 0) sections.push({ heading: "Wins", items: sliceWithEllipsis(wins) });
  if (highlights.length > 0) sections.push({ heading: "Highlights", items: sliceWithEllipsis(highlights) });
  if (lowlights.length > 0) sections.push({ heading: "Lowlights", items: sliceWithEllipsis(lowlights) });
  return sections;
}

function trimBlock(text: string): string {
  return text.length <= MAX_BLOCK_LENGTH ? text : `${text.slice(0, MAX_BLOCK_LENGTH - 1)}…`;
}

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Builds deterministic share-ready text blocks. */
export function buildShareBlocks(report: Report): ShareBlocks {
  const sections = getSections(report);
  const heading = `${report.title}\n${report.periodStart} → ${report.periodEnd}`;
  const plainText = trimBlock([
    heading,
    ...sections.map((section) => `${section.heading}:\n${section.items.map((item) => `- ${item}`).join("\n")}`),
  ].join("\n\n"));

  const reportUrl = `/reports/${encodeURIComponent(report.id)}`;
  const markdown = trimBlock([
    `## ${escapeMarkdown(report.title)}`,
    `Period: ${escapeMarkdown(report.periodStart)} → ${escapeMarkdown(report.periodEnd)}`,
    ...sections.map((section) => `### ${section.heading}\n${section.items.map((item) => `- ${escapeMarkdown(item)}`).join("\n")}`),
    `[Open report](${reportUrl})`,
  ].join("\n\n"));

  const slack = trimBlock([
    `*${report.title}*`,
    `${report.periodStart} → ${report.periodEnd}`,
    ...sections.map((section) => `*${section.heading}*\n${section.items.map((item) => `• ${item}`).join("\n")}`),
    `<${reportUrl}|Open report>`,
  ].join("\n\n"));

  // Note: emailHtml uses hardcoded hex/inline styles for email-client compatibility — design-token rule does not apply here.
  const emailHtml = [
    `<div style="font-family:Arial,sans-serif;color:#1f2328;line-height:1.5;">`,
    `<h2 style="margin:0 0 12px;color:#5B8DEF;">${escapeHtml(report.title)}</h2>`,
    `<p style="margin:0 0 12px;">Period: ${escapeHtml(report.periodStart)} → ${escapeHtml(report.periodEnd)}</p>`,
    ...sections.map((section) => `<h3 style="margin:12px 0 6px;">${escapeHtml(section.heading)}</h3><ul style="margin:0 0 12px;padding-left:20px;">${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`),
    `<p style="margin:0;"><a href="${escapeHtml(reportUrl)}" style="color:#5B8DEF;">Open report</a></p>`,
    `</div>`,
  ].join("");

  return { plainText, markdown, slack, emailHtml };
}
