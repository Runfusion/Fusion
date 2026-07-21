import { describe, expect, it, vi } from "vitest";
import { runReportPipeline, type ReportPipelineDeps, type ReportScreenshot } from "../report-pipeline.js";

const settings = { reportMode: "auto-file" as const, reportDiscussionCategory: "general", reportRoadmapDedupeEnabled: false, githubTrackingDefaultRepo: "Runfusion/Fusion", githubAuthMode: "token", githubAuthToken: "test" };
const screenshot: ReportScreenshot = { artifactId: "f1e2d3c4-b5a6-4789-8abc-def012345678", filename: "/Users/alice/private-project/evil[alt](break)!../capture.png", mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };

function client() {
  return {
    createIssue: vi.fn().mockResolvedValue({ htmlUrl: "https://github.com/Runfusion/Fusion/issues/42" }), createDiscussion: vi.fn().mockResolvedValue({ htmlUrl: "https://github.com/Runfusion/Fusion/discussions/42" }),
    searchIssues: vi.fn().mockResolvedValue([]), searchDiscussions: vi.fn().mockResolvedValue([]),
    commentOnIssue: vi.fn().mockResolvedValue({ url: "issue-comment" }), commentOnDiscussion: vi.fn().mockResolvedValue({ url: "discussion-comment" }),
    addIssueReaction: vi.fn(), addDiscussionReaction: vi.fn(),
    listDiscussionCategories: vi.fn().mockResolvedValue([{ id: "DC_1", name: "General", slug: "general" }]),
    uploadImageAsset: vi.fn().mockResolvedValue({ rawUrl: "https://raw.githubusercontent.com/Runfusion/Fusion/main/.fusion-reports/safe/screenshot.png" }),
  };
}

function deps(fakeClient = client()): ReportPipelineDeps {
  return { projectSettings: settings, client: fakeClient, scrubContext: { rootDir: "/Users/alice/private-project", projectName: "private-project" } };
}

describe("report screenshot embedding", () => {
  it("uploads and embeds one resolved PNG in a filed issue without leaking untrusted path input", async () => {
    const fakeClient = client();
    const result = await runReportPipeline({ actionType: "bug", userPrompt: "Report failure", attachment: screenshot }, deps(fakeClient), { file: true });

    expect(result.kind).toBe("filed");
    expect(fakeClient.uploadImageAsset).toHaveBeenCalledTimes(1);
    expect(fakeClient.uploadImageAsset).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringMatching(/^\.fusion-reports\/[a-f0-9]{32}\/screenshot\.png$/), contentBase64: screenshot.bytes.toString("base64") }));
    const body = fakeClient.createIssue.mock.calls[0][0].body as string;
    expect(body).toContain("## Screenshots");
    expect(body).toMatch(/!\[[^\r\n]*\\\[alt\\\]\\\(break\\\)\\![^\r\n]*\]\(https:\/\/raw\.githubusercontent\.com\/Runfusion\/Fusion\/main\/\.fusion-reports\/safe\/screenshot\.png\)/);
    expect(body).not.toContain("private-project");
    expect(body).not.toContain("/Users/alice");
    expect(body).not.toContain(".fusion-reports/../");
  });

  it("does not upload or alter a filed body without the optional screenshot", async () => {
    const fakeClient = client();
    await runReportPipeline({ actionType: "idea", userPrompt: "Add a filter" }, deps(fakeClient), { file: true });
    expect(fakeClient.uploadImageAsset).not.toHaveBeenCalled();
    expect(fakeClient.createIssue.mock.calls[0][0].body).not.toContain("## Screenshots");
  });

  it.each(["feedback", "help"] as const)("embeds screenshots in filed %s discussions", async (actionType) => {
    const fakeClient = client();
    await runReportPipeline({ actionType, userPrompt: "Clarify report status", attachment: screenshot }, deps(fakeClient), { file: true });
    expect(fakeClient.uploadImageAsset).toHaveBeenCalledTimes(1);
    expect(fakeClient.createDiscussion.mock.calls[0][3]).toContain("## Screenshots");
  });

  it("keeps filing the scrubbed text body if hosting fails", async () => {
    const fakeClient = client();
    fakeClient.uploadImageAsset.mockRejectedValueOnce(new Error("permission denied"));
    const result = await runReportPipeline({ actionType: "bug", userPrompt: "Report failure", attachment: screenshot }, deps(fakeClient), { file: true });
    expect(result.kind).toBe("filed");
    expect(fakeClient.createIssue).toHaveBeenCalledTimes(1);
    expect(fakeClient.createIssue.mock.calls[0][0].body).not.toContain("## Screenshots");
  });

  it("embeds the one screenshot in an endorsed duplicate data-point comment", async () => {
    const fakeClient = client();
    fakeClient.searchIssues.mockResolvedValue([{ number: 7, title: "dashboard rendering failed", body: "dashboard rendering failed", html_url: "issue", state: "open" }]);
    await runReportPipeline({ actionType: "bug", userPrompt: "dashboard rendering failed", attachment: screenshot }, deps(fakeClient), { file: true, endorseIssueNumber: 7 });
    expect(fakeClient.uploadImageAsset).toHaveBeenCalledTimes(1);
    expect(fakeClient.commentOnIssue.mock.calls[0][3]).toContain("## Screenshots");
  });
});
