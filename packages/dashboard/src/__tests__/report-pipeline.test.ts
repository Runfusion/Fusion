import { describe, expect, it, vi } from "vitest";
import { endorseDuplicate, runReportPipeline, type ReportPipelineDeps } from "../report-pipeline.js";

const settings = { reportMode: "draft-review" as const, githubTrackingDefaultRepo: "Runfusion/Fusion", githubAuthMode: "token", githubAuthToken: "test" };

function deps(overrides: Partial<ReportPipelineDeps> = {}): ReportPipelineDeps {
  return {
    projectSettings: settings,
    client: { createIssue: vi.fn().mockResolvedValue({ htmlUrl: "https://github.com/Runfusion/Fusion/issues/42" }), searchIssues: vi.fn().mockResolvedValue([]), addIssueReaction: vi.fn(), commentOnIssue: vi.fn().mockResolvedValue({ url: "https://github.com/Runfusion/Fusion/issues/1#issuecomment-1" }), searchDiscussions: vi.fn().mockResolvedValue([]), createDiscussion: vi.fn().mockResolvedValue({ htmlUrl: "https://github.com/Runfusion/Fusion/discussions/42" }), commentOnDiscussion: vi.fn().mockResolvedValue({ url: "https://github.com/Runfusion/Fusion/discussions/1#discussioncomment-1" }) },
    scrubContext: { projectName: "private-project", rootDir: "/Users/alice/private-project" },
    ...overrides,
  };
}

describe("report pipeline", () => {
  it.each(["bug", "feedback", "idea", "help"] as const)("structures the guided %s prompt without filing in review mode", async (actionType) => {
    const context = deps();
    const result = await runReportPipeline({ actionType, userPrompt: "The private-project view failed at /Users/alice/private-project/a.ts" }, context);
    expect(result.kind).toBe("draft-ready");
    if (result.kind === "draft-ready") {
      expect(result.report.userPrompt).toContain("[REDACTED]");
      expect(result.report.body).toContain("## Expected behavior");
      expect(result.report.body).toContain("## Actual behavior / request");
      expect(result.report.body).toContain("## Environment");
    }
    expect(context.client!.createIssue).not.toHaveBeenCalled();
  });

  it("scrubs activity trace text along with all report context", async () => {
    const result = await runReportPipeline({
      actionType: "bug",
      userPrompt: "report failure",
      activityTrace: [{ ts: "2026-07-16T00:00:00Z", kind: "error", label: "Jane Doe at /Users/alice/private-project/a.ts emailed alice@example.com with ghp_abcdefghijk1234567890 and sk-abcdefghijklmnopqrstuvwxyz" }],
    }, deps());
    expect(result.kind).toBe("draft-ready");
    if (result.kind === "draft-ready") {
      expect(result.report.body).toContain("activityTrace");
      expect(result.report.body).not.toMatch(/private-project|alice@example\.com|ghp_|sk-|Jane Doe/);
    }
  });

  it("only accepts open duplicate matches", async () => {
    const context = deps({ client: { createIssue: vi.fn(), addIssueReaction: vi.fn(), commentOnIssue: vi.fn(), searchIssues: vi.fn().mockResolvedValue([{ number: 1, title: "dashboard rendering failed issue", body: "dashboard rendering failed", html_url: "url", state: "closed" }]) } });
    const result = await runReportPipeline({ actionType: "bug", userPrompt: "dashboard rendering failed" }, context);
    expect(result.kind).toBe("draft-ready");
  });

  it.each(["bug", "feedback", "idea", "help"] as const)("short-circuits %s reports that strongly match the roadmap without egress", async (actionType) => {
    const roadmapSource = vi.fn().mockResolvedValue([{ featureId: "RF-1", title: "Dashboard rendering controls", body: "Add dashboard rendering controls" }]);
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file", reportRoadmapDedup: true }, roadmapSource });
    const result = await runReportPipeline({ actionType, userPrompt: "Add dashboard rendering controls" }, context);
    expect(result).toMatchObject({ kind: "roadmap-match", roadmap: { featureId: "RF-1", title: "Dashboard rendering controls", description: "Add dashboard rendering controls" } });
    expect(roadmapSource).toHaveBeenCalledOnce();
    expect(context.client!.createIssue).not.toHaveBeenCalled();
    expect(context.client!.createDiscussion).not.toHaveBeenCalled();
    expect(context.client!.commentOnIssue).not.toHaveBeenCalled();
    expect(context.client!.commentOnDiscussion).not.toHaveBeenCalled();
  });

  it("does not read the roadmap source when its opt-in setting is off", async () => {
    const roadmapSource = vi.fn().mockResolvedValue([{ featureId: "RF-1", title: "Dashboard rendering controls", body: "Add dashboard rendering controls" }]);
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file", reportRoadmapDedup: false }, roadmapSource });
    const result = await runReportPipeline({ actionType: "idea", userPrompt: "Add dashboard rendering controls" }, context);
    expect(result.kind).toBe("filed");
    expect(roadmapSource).not.toHaveBeenCalled();
    expect(context.client!.createIssue).toHaveBeenCalledOnce();
  });

  it("falls through to existing GitHub routing when roadmap candidates do not match", async () => {
    const context = deps({
      projectSettings: { ...settings, reportMode: "auto-file", reportRoadmapDedup: true },
      roadmapSource: vi.fn().mockResolvedValue([{ featureId: "RF-1", title: "Unrelated access controls", body: "Manage permissions" }]),
    });
    const result = await runReportPipeline({ actionType: "idea", userPrompt: "Add dashboard rendering controls" }, context);
    expect(result.kind).toBe("filed");
    expect(context.client!.createIssue).toHaveBeenCalledOnce();
  });

  it("files in auto-file mode", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file" } });
    const result = await runReportPipeline({ actionType: "idea", userPrompt: "Add dashboard rendering controls" }, context);
    expect(result.kind).toBe("filed");
    expect(context.client!.createIssue).toHaveBeenCalledOnce();
  });

  it("files feedback as a repository discussion in auto-file mode", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file" } });
    const result = await runReportPipeline({ actionType: "feedback", userPrompt: "The report flow needs clearer status" }, context);
    expect(result.kind).toBe("filed");
    expect(context.client!.createDiscussion).toHaveBeenCalledOnce();
    expect(context.client!.createIssue).not.toHaveBeenCalled();
  });

  it("automatically endorses an open duplicate in auto-file mode", async () => {
    const client = {
      createIssue: vi.fn(),
      addIssueReaction: vi.fn(),
      commentOnIssue: vi.fn().mockResolvedValue({ url: "https://github.com/Runfusion/Fusion/issues/9#issuecomment-9" }),
      searchIssues: vi.fn().mockResolvedValue([{ number: 9, title: "dashboard rendering controls", body: "dashboard rendering controls", html_url: "https://github.com/Runfusion/Fusion/issues/9", state: "open" }]),
    };
    const result = await runReportPipeline({ actionType: "idea", userPrompt: "Add dashboard rendering controls" }, deps({ projectSettings: { ...settings, reportMode: "auto-file" }, client }));
    expect(result.kind).toBe("endorsed");
    expect(client.addIssueReaction).toHaveBeenCalledWith("Runfusion", "Fusion", 9, "+1");
    expect(client.commentOnIssue).toHaveBeenCalledOnce();
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("endorses a duplicate discussion with a reaction and one scrubbed data point", async () => {
    const client = {
      createIssue: vi.fn(),
      addIssueReaction: vi.fn(),
      commentOnIssue: vi.fn(),
      searchIssues: vi.fn(),
      searchDiscussions: vi.fn().mockResolvedValue([{ id: "D_kwDO1", number: 6, title: "report flow status feedback", body: "status feedback", url: "https://github.com/Runfusion/Fusion/discussions/6", state: "open" }]),
      addDiscussionReaction: vi.fn(),
      commentOnDiscussion: vi.fn().mockResolvedValue({ url: "https://github.com/Runfusion/Fusion/discussions/6#discussioncomment-1" }),
    };
    const result = await runReportPipeline({ actionType: "feedback", userPrompt: "report flow status feedback" }, deps({ projectSettings: { ...settings, reportMode: "auto-file" }, client }));
    expect(result.kind).toBe("endorsed");
    expect(client.addDiscussionReaction).toHaveBeenCalledWith("D_kwDO1");
    expect(client.commentOnDiscussion).toHaveBeenCalledOnce();
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("preserves reviewed gathered context and session token when filing", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file" } });
    const result = await runReportPipeline({ actionType: "bug", userPrompt: "reviewed prompt" }, context, {
      file: true,
      report: { userPrompt: "reviewed prompt", summary: "Reviewed summary", body: "Reviewed gathered context", context: { taskId: "FN-1", recentLogs: ["error"] }, sessionToken: "preserved-session" },
    });
    expect(result.kind).toBe("filed");
    if (result.kind === "filed") expect(result.report).toMatchObject({ body: "Reviewed gathered context", sessionToken: "preserved-session", context: { taskId: "FN-1" } });
  });

  it("rebuilds derived fields when the reviewed prompt changes", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file" } });
    const result = await runReportPipeline({ actionType: "bug", userPrompt: "original prompt" }, context, {
      file: true,
      report: { userPrompt: "edited prompt", sourcePrompt: "original prompt", summary: "[bug] original prompt", body: "## Summary\noriginal prompt", context: {} },
    });
    expect(result.kind).toBe("filed");
    expect(context.client!.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: "[bug] edited prompt",
      body: expect.stringContaining("edited prompt"),
    }));
  });

  it("only endorses an issue that is still an open matching duplicate", async () => {
    const client = {
      createIssue: vi.fn(),
      addIssueReaction: vi.fn(),
      commentOnIssue: vi.fn(),
      searchIssues: vi.fn().mockResolvedValue([{ number: 7, title: "unrelated report", body: "unrelated report", html_url: "url", state: "closed" }]),
    };
    const result = await runReportPipeline({ actionType: "bug", userPrompt: "dashboard rendering failed" }, deps({ client }), { file: true, endorseIssueNumber: 7 });
    expect(result).toMatchObject({ kind: "unavailable", reason: "duplicate_not_verified" });
    expect(client.commentOnIssue).not.toHaveBeenCalled();
  });

  it("posts one scrubbed duplicate endorsement per report session", async () => {
    const context = deps();
    const report = { userPrompt: "private-project", summary: "dashboard rendering failed", body: "/Users/alice/private-project ghp_abcdefghijk1234567890", context: {}, sessionToken: "session-test" };
    const first = await endorseDuplicate({ owner: "Runfusion", repo: "Fusion", issueNumber: 1, report, client: context.client!, scrubContext: context.scrubContext });
    const second = await endorseDuplicate({ owner: "Runfusion", repo: "Fusion", issueNumber: 1, report, client: context.client!, scrubContext: context.scrubContext });
    expect(first.url).toContain("issuecomment");
    expect(second).toEqual(first);
    expect(context.client!.addIssueReaction).toHaveBeenCalledOnce();
    expect(context.client!.commentOnIssue).toHaveBeenCalledOnce();
    expect(String((context.client!.commentOnIssue as ReturnType<typeof vi.fn>).mock.calls[0][3])).not.toContain("private-project");
  });
});
