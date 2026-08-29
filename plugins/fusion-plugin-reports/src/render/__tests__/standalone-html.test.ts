import { describe, expect, it } from "vitest";
import type { Report } from "../../store/report-types.js";
import { renderStandaloneReportHtml, slugifyReportFilename } from "../standalone-html.js";

function createRecord(metadata: Record<string, unknown> = {}): Report {
  return {
    id: "rep_1",
    cadence: "daily",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-02",
    title: "Demo",
    status: "review_complete",
    generationStartedAt: "2026-05-02T00:00:00.000Z",
    generationCompletedAt: "2026-05-02T00:01:00.000Z",
    reviewStartedAt: null,
    reviewCompletedAt: null,
    approvedAt: null,
    approvedBy: null,
    publishedAt: null,
    archivedAt: null,
    failureReason: null,
    approvalState: "not_required",
    approvalHistory: [],
    draftMarkdown: null,
    renderedHtmlPath: null,
    renderedHtml: null,
    renderedHtmlGeneratedAt: null,
    metadata,
    combinedReview: null,
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:01:00.000Z",
  };
}

describe("renderStandaloneReportHtml", () => {
  it("renders one full html document with one style block", () => {
    const html = renderStandaloneReportHtml(createRecord());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect((html.match(/<style>/g) ?? []).length).toBe(1);
    expect(html).toContain("--space-xs");
  });

  it("contains no external links except allowlisted ones", () => {
    const html = renderStandaloneReportHtml(createRecord());
    const matches = [...html.matchAll(/(href|src)=\"https?:[^\"]+/gi)];
    expect(matches.length).toBe(0);
  });

  it("strips external image sources", () => {
    const html = renderStandaloneReportHtml(createRecord({
      settings: { branding: { logoDataUri: "http://example.com/logo.png" } },
    }));
    expect(html).not.toContain("http://example.com/logo.png");
  });

  it("is deterministic for same input", () => {
    const a = renderStandaloneReportHtml(createRecord());
    const b = renderStandaloneReportHtml(createRecord());
    expect(a).toBe(b);
  });

  it("slugifies report filenames", () => {
    const slug = slugifyReportFilename({ title: "My Weekly Report", periodStart: "2026-05-01", periodEnd: "2026-05-02" });
    expect(slug).toBe("my-weekly-report-2026-05-01-2026-05-02.html");
  });
});
