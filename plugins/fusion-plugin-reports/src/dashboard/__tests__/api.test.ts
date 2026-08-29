import { describe, expect, it, vi } from "vitest";
import { getReportExportUrl, getReportPreviewHtml, listReports } from "../api.js";

describe("api", () => {
  it("lists reports", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reports: [{ id: "R-1" }] }) }));
    const reports = await listReports();
    expect(reports).toHaveLength(1);
  });

  it("reads preview html", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "<article/>" }));
    await expect(getReportPreviewHtml("R-1")).resolves.toContain("article");
  });

  it("builds export url", () => {
    expect(getReportExportUrl("R-1")).toContain("/reports/R-1/export.html");
  });
});
