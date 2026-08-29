import { describe, expect, it } from "vitest";
import type { Report } from "../../store/report-types.js";
import { renderReportHtml } from "../html-template.js";

function createRecord(overrides: Partial<Report> = {}, metadata: Record<string, unknown> = {}): Report {
  const base: Report = {
    id: "rep_1",
    cadence: "daily",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-02",
    title: "Weekly report",
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
    combinedReview: null,
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:01:00.000Z",
    metadata,
    renderedHtml: null,
    renderedHtmlGeneratedAt: null,
  };
  return {
    ...base,
    ...overrides,
    renderedHtml: overrides.renderedHtml ?? base.renderedHtml,
    renderedHtmlGeneratedAt: overrides.renderedHtmlGeneratedAt ?? base.renderedHtmlGeneratedAt,
  };
}

describe("renderReportHtml", () => {
  it("renders shell for empty record", () => {
    const html = renderReportHtml(createRecord());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("data-section=\"data-coverage\"");
  });

  it("renders mixed sections with markers", () => {
    const html = renderReportHtml(createRecord({}, {
      sections: {
        summary: "hello",
        system: { wins: ["w1"], highlights: ["h1"], lowlights: ["l1"], proposals: ["p1"], deepDives: ["d1"] },
        perAgent: [{ agentId: "a1", wins: ["x"] }],
      },
    }));
    expect(html).toContain('data-section="summary"');
    expect(html).toContain('data-section="system-wins"');
    expect(html).toContain('data-section="system-highlights"');
    expect(html).toContain('data-section="system-lowlights"');
    expect(html).toContain('data-section="system-proposals"');
    expect(html).toContain('data-section="system-deep-dives"');
    expect(html).toContain('data-section="agent-card"');
  });

  it("omits toggled off sections", () => {
    const html = renderReportHtml(createRecord({}, {
      settings: { enabledSections: ["wins"] },
      sections: { system: { wins: ["w1"], highlights: ["h1"] } },
    }));
    expect(html).toContain('data-section="system-wins"');
    expect(html).not.toContain('data-section="system-highlights"');
  });

  it("respects section order", () => {
    const html = renderReportHtml(createRecord({}, {
      settings: { sectionOrder: ["proposals", "wins"], enabledSections: ["wins", "proposals"] },
      sections: { system: { wins: ["w1"], proposals: ["p1"] } },
    }));
    expect(html.indexOf('data-section="system-proposals"')).toBeLessThan(html.indexOf('data-section="system-wins"'));
  });

  it("renders per-agent cards with stable ids", () => {
    const html = renderReportHtml(createRecord({}, {
      sections: { perAgent: [{ agentId: "agent-1" }, { agentId: "agent-2" }] },
    }));
    expect(html).toContain('data-agent-id="agent-1"');
    expect(html).toContain('data-agent-id="agent-2"');
  });

  it("escapes hostile inputs", () => {
    const html = renderReportHtml(createRecord({}, {
      sections: { summary: '<script>alert(1)</script> " onmouseover=' },
    }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("javascript:");
  });

  it("applies explicit theme", () => {
    const dark = renderReportHtml(createRecord(), { theme: "dark" });
    const light = renderReportHtml(createRecord(), { theme: "light" });
    expect(dark).toContain('data-theme="dark"');
    expect(light).toContain('data-theme="light"');
  });

  it("returns body-only when includeChrome false", () => {
    const body = renderReportHtml(createRecord(), { includeChrome: false });
    expect(body.startsWith("<!doctype html>")).toBe(false);
    expect(body.startsWith("<article")).toBe(true);
  });
});
