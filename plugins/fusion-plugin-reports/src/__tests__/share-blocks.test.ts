import { describe, expect, it } from "vitest";
import { buildShareBlocks } from "../share-blocks.js";
import type { Report } from "../store/report-types.js";

function makeReport(): Report {
  return {
    id: "rep_1",
    cadence: "weekly",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-07",
    title: "Weekly <Report> & \"Status\"",
    status: "published",
    generationStartedAt: "2026-05-01T00:00:00.000Z",
    generationCompletedAt: null,
    reviewStartedAt: null,
    reviewCompletedAt: null,
    approvedAt: null,
    approvedBy: null,
    publishedAt: null,
    archivedAt: null,
    failureReason: null,
    approvalState: "published",
    approvalHistory: [],
    draftMarkdown: null,
    renderedHtmlPath: null,
    renderedHtml: null,
    renderedHtmlGeneratedAt: null,
    metadata: {},
    combinedReview: {
      overallVerdict: "approve",
      consensusSummary: "ok",
      mergedHighlights: ["Win <script>alert(1)</script>", "Win 2"],
      mergedLowlights: ["Low & bad"],
      mergedSuggestions: ["Do \"x\""],
      individual: [],
      failures: [],
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

describe("buildShareBlocks", () => {
  it("builds deterministic outputs", () => {
    const report = makeReport();
    const first = buildShareBlocks(report);
    const second = buildShareBlocks(report);
    expect(first).toEqual(second);
    expect(first.markdown).toContain("## Weekly \\\<Report\\\>");
    expect(first.slack).toContain("*Weekly <Report> & \"Status\"*");
  });

  it("escapes markdown and html", () => {
    const blocks = buildShareBlocks(makeReport());
    expect(blocks.markdown).toContain("\\<Report\\>");
    expect(blocks.emailHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(blocks.emailHtml).toContain("&amp;");
    expect(blocks.emailHtml).toContain("&quot;Status&quot;");
  });

  it("omits empty sections", () => {
    const report = makeReport();
    report.combinedReview = {
      overallVerdict: "approve",
      consensusSummary: "ok",
      mergedHighlights: [],
      mergedLowlights: [],
      mergedSuggestions: [],
      individual: [],
      failures: [],
    };
    const blocks = buildShareBlocks(report);
    expect(blocks.plainText).not.toContain("Wins:");
    expect(blocks.markdown).not.toContain("### Wins");
  });

  it("slack block avoids markdown-only constructs", () => {
    const blocks = buildShareBlocks(makeReport());
    expect(blocks.slack).not.toContain("#");
    expect(blocks.slack).not.toContain("**");
    expect(blocks.slack).not.toContain("- ");
  });
});
