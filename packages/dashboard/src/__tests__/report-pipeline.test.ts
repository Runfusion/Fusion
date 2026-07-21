import { describe, expect, it, vi } from "vitest";
import { DiscussionsDisabledError } from "../github.js";
import { endorseDuplicate, resolveReportTarget, runReportPipeline, type ReportPipelineDeps } from "../report-pipeline.js";

const settings = { reportRoadmapDedupeEnabled: false, reportMode: "draft-review" as const, githubTrackingDefaultRepo: "Runfusion/Fusion", githubAuthMode: "token", githubAuthToken: "test" };

function deps(overrides: Partial<ReportPipelineDeps> = {}): ReportPipelineDeps {
  return {
    projectSettings: settings,
    client: { createIssue: vi.fn().mockResolvedValue({ number: 42, htmlUrl: "https://github.com/Runfusion/Fusion/issues/42" }), searchIssues: vi.fn().mockResolvedValue([]), addIssueReaction: vi.fn(), commentOnIssue: vi.fn().mockResolvedValue({ url: "https://github.com/Runfusion/Fusion/issues/1#issuecomment-1" }), searchDiscussions: vi.fn().mockResolvedValue([]), createDiscussion: vi.fn().mockResolvedValue({ htmlUrl: "https://github.com/Runfusion/Fusion/discussions/42" }), commentOnDiscussion: vi.fn().mockResolvedValue({ url: "https://github.com/Runfusion/Fusion/discussions/1#discussioncomment-1" }), listDiscussionCategories: vi.fn().mockResolvedValue([{ id: "DC_ideas", name: "Ideas", slug: "ideas" }]) },
    scrubContext: { projectName: "private-project", rootDir: "/Users/alice/private-project" },
    ...overrides,
  };
}

describe("report pipeline", () => {
  it.each([
    ["bug", "issue"], ["feedback", "discussion"], ["idea", "issue"], ["help", "discussion"],
  ] as const)("preserves the historical %s → %s target when settings are unset", (actionType, target) => {
    expect(resolveReportTarget(actionType, {})).toBe(target);
  });

  it("uses per-action settings and an explicit target override in precedence order", () => {
    const configured = { reportTarget: "discussion" as const, reportTargetByAction: { feedback: "issue" as const } };
    expect(resolveReportTarget("feedback", configured)).toBe("issue");
    expect(resolveReportTarget("bug", configured)).toBe("discussion");
    expect(resolveReportTarget("feedback", configured, "discussion")).toBe("discussion");
  });

  it("ignores malformed persisted targets rather than silently filing them as Issues", () => {
    const malformed = { reportTarget: "not-a-target", reportTargetByAction: { feedback: "also-invalid" } } as never;
    expect(resolveReportTarget("feedback", malformed)).toBe("discussion");
    expect(resolveReportTarget("bug", malformed)).toBe("issue");
  });

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
      activityTrace: ["Jane Doe at /Users/alice/private-project/a.ts emailed alice@example.com with ghp_abcdefghijk1234567890 and sk-abcdefghijklmnopqrstuvwxyz"],
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

  it.each(["bug", "feedback", "idea", "help"] as const)("deduplicates %s reports against an open labeled roadmap issue in auto-file mode", async (actionType) => {
    const client = {
      createIssue: vi.fn(), createDiscussion: vi.fn(), addIssueReaction: vi.fn(), commentOnIssue: vi.fn().mockResolvedValue({ url: "roadmap-comment" }),
      searchIssues: vi.fn().mockImplementation((_owner, _repo, query) => Promise.resolve(query.includes("label:roadmap") ? [{ number: 30, title: "dashboard rendering controls", body: "dashboard rendering controls", html_url: "roadmap-url", state: "open" }] : [])),
      searchDiscussions: vi.fn().mockResolvedValue([]),
    };
    const result = await runReportPipeline({ actionType, userPrompt: "Add dashboard rendering controls" }, deps({ projectSettings: { ...settings, reportMode: "auto-file", reportRoadmapDedupeEnabled: true }, client }));
    expect(result).toMatchObject({ kind: "endorsed", issueNumber: 30 });
    expect(client.addIssueReaction).toHaveBeenCalledWith("Runfusion", "Fusion", 30, "+1");
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createDiscussion).not.toHaveBeenCalled();
  });

  it.each(["bug", "feedback"] as const)("returns an endorseable roadmap duplicate for %s reports in draft-review mode", async (actionType) => {
    const client = {
      createIssue: vi.fn(), addIssueReaction: vi.fn(), commentOnIssue: vi.fn(), searchDiscussions: vi.fn().mockResolvedValue([]),
      searchIssues: vi.fn().mockImplementation((_owner, _repo, query) => Promise.resolve(query.includes("label:roadmap") ? [{ number: 30, title: "dashboard rendering controls", body: "dashboard rendering controls", html_url: "roadmap-url", state: "open" }] : [])),
    };
    const result = await runReportPipeline({ actionType, userPrompt: "Add dashboard rendering controls" }, deps({ projectSettings: { ...settings, reportRoadmapDedupeEnabled: true }, client }));
    expect(result).toMatchObject({ kind: "duplicate-found", issue: { number: 30, roadmap: true } });
    expect(client.addIssueReaction).not.toHaveBeenCalled();
  });

  it("ignores closed or disabled roadmap items and falls through to filing", async () => {
    const client = { createIssue: vi.fn().mockResolvedValue({ htmlUrl: "filed" }), addIssueReaction: vi.fn(), commentOnIssue: vi.fn(), searchIssues: vi.fn().mockResolvedValue([{ number: 30, title: "dashboard rendering controls", body: "dashboard rendering controls", html_url: "roadmap-url", state: "closed" }]) };
    const result = await runReportPipeline({ actionType: "idea", userPrompt: "Add dashboard rendering controls" }, deps({ projectSettings: { ...settings, reportMode: "auto-file", reportRoadmapDedupeEnabled: false }, client }));
    expect(result.kind).toBe("filed");
    expect(client.addIssueReaction).not.toHaveBeenCalled();
  });

  it("prefers a roadmap issue over a matching ordinary destination issue", async () => {
    const client = { createIssue: vi.fn(), addIssueReaction: vi.fn(), commentOnIssue: vi.fn().mockResolvedValue({ url: "roadmap-comment" }), searchIssues: vi.fn().mockImplementation((_owner, _repo, query) => Promise.resolve([{ number: query.includes("label:roadmap") ? 30 : 9, title: "dashboard rendering controls", body: "dashboard rendering controls", html_url: "url", state: "open" }])) };
    const result = await runReportPipeline({ actionType: "idea", userPrompt: "Add dashboard rendering controls" }, deps({ projectSettings: { ...settings, reportMode: "auto-file", reportRoadmapDedupeEnabled: true }, client }));
    expect(result).toMatchObject({ kind: "endorsed", issueNumber: 30 });
  });

  it("re-verifies a roadmap endorsement and preserves session idempotency", async () => {
    const client = { createIssue: vi.fn(), addIssueReaction: vi.fn(), commentOnIssue: vi.fn().mockResolvedValue({ url: "roadmap-comment" }), searchIssues: vi.fn().mockImplementation((_owner, _repo, query) => Promise.resolve(query.includes("label:roadmap") ? [{ number: 30, title: "dashboard rendering controls", body: "dashboard rendering controls", html_url: "url", state: "open" }] : [])) };
    const report = { userPrompt: "Add dashboard rendering controls at /Users/alice/private-project", summary: "Add dashboard rendering controls", body: "secret path /Users/alice/private-project", context: {}, sessionToken: "roadmap-session" };
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file", reportRoadmapDedupeEnabled: true }, client });
    await runReportPipeline({ actionType: "idea", userPrompt: report.userPrompt }, context, { file: true, endorseRoadmapIssueNumber: 30, report });
    await runReportPipeline({ actionType: "idea", userPrompt: report.userPrompt }, context, { file: true, endorseRoadmapIssueNumber: 30, report });
    expect(client.addIssueReaction).toHaveBeenCalledOnce();
    expect(client.commentOnIssue).toHaveBeenCalledOnce();
    expect(String(client.commentOnIssue.mock.calls[0][3])).not.toContain("private-project");
  });

  it("resolves roadmap settings project then global then defaults", async () => {
    const { resolveRoadmapDedupe } = await import("../report-pipeline.js");
    expect(resolveRoadmapDedupe({ projectSettings: { ...settings, reportRoadmapDedupeEnabled: false }, globalSettings: { reportRoadmapDedupeEnabled: true } }).enabled).toBe(false);
    expect(resolveRoadmapDedupe({ projectSettings: settings, globalSettings: { reportRoadmapDedupeEnabled: false, reportRoadmapLabel: "planned", reportRoadmapRepo: "other/tracker" } })).toMatchObject({ enabled: false, label: "planned", repo: { owner: "other", repo: "tracker" } });
    expect(resolveRoadmapDedupe({ projectSettings: settings }).label).toBe("roadmap");
  });

  it("files in auto-file mode", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file" } });
    const result = await runReportPipeline({ actionType: "idea", userPrompt: "Add dashboard rendering controls" }, context);
    expect(result.kind).toBe("filed");
    expect(context.client!.createIssue).toHaveBeenCalledOnce();
  });

  it("files enabled Discussions with the configured category and destination", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file", reportDiscussionCategory: "DC_ideas" } });
    const result = await runReportPipeline({ actionType: "feedback", userPrompt: "The report flow needs clearer status" }, context);
    expect(result).toMatchObject({ kind: "filed", destination: "discussion" });
    expect(context.client!.createDiscussion).toHaveBeenCalledWith("Runfusion", "Fusion", expect.any(String), expect.any(String), "DC_ideas");
    expect(context.client!.createIssue).not.toHaveBeenCalled();
  });

  it("lets a per-action target override flip feedback to an issue and bug to a discussion", async () => {
    const feedback = deps({ projectSettings: { ...settings, reportMode: "auto-file", reportDiscussionCategory: "DC_ideas", reportTargetByAction: { feedback: "issue", bug: "discussion" } } });
    await runReportPipeline({ actionType: "feedback", userPrompt: "Report status needs clarity" }, feedback);
    await runReportPipeline({ actionType: "bug", userPrompt: "Report failure needs attention" }, feedback);
    expect(feedback.client!.createIssue).toHaveBeenCalledOnce();
    expect(feedback.client!.createDiscussion).toHaveBeenCalledOnce();
  });


  it("uses an explicit Discussion category before the FN-8308 persisted default", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file", reportDiscussionCategory: "DC_default" } });
    await runReportPipeline({ actionType: "feedback", userPrompt: "Report status needs clarity" }, context, { discussionCategoryId: "DC_explicit" });
    expect(context.client!.createDiscussion).toHaveBeenCalledWith("Runfusion", "Fusion", expect.any(String), expect.any(String), "DC_explicit");
  });

  it("maps Discussion search and endorsement GraphQL failures to a safe unavailable result", async () => {
    const searchFailure = deps({
      projectSettings: { ...settings, reportMode: "auto-file", reportTarget: "discussion", reportDiscussionCategory: "DC_ideas" },
      client: { ...deps().client!, searchDiscussions: vi.fn().mockRejectedValue(new Error("scope missing")) },
    });
    await expect(runReportPipeline({ actionType: "bug", userPrompt: "Report failure needs attention" }, searchFailure))
      .resolves.toMatchObject({ kind: "unavailable", reason: "discussion_unavailable" });

    const endorseFailure = deps({
      projectSettings: { ...settings, reportMode: "auto-file" },
      client: {
        ...deps().client!,
        searchDiscussions: vi.fn().mockResolvedValue([{ id: "D_fail", number: 2, title: "report failure needs attention", body: "report failure needs attention", url: "https://github.com/Runfusion/Fusion/discussions/2", state: "open" }]),
        addDiscussionReaction: vi.fn().mockRejectedValue(new Error("Discussions disabled")),
      },
    });
    await expect(runReportPipeline({ actionType: "feedback", userPrompt: "report failure needs attention" }, endorseFailure))
      .resolves.toMatchObject({ kind: "unavailable", reason: "discussion_unavailable" });
  });

  it("ignores a supplied Discussion category for Issue-targeted actions", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file" } });
    const result = await runReportPipeline({ actionType: "bug", userPrompt: "Report failure needs attention" }, context, { discussionCategoryId: "DC_ignored" });
    expect(result).toMatchObject({ kind: "filed", destination: "issue" });
    expect(context.client!.createDiscussion).not.toHaveBeenCalled();
    expect(context.client!.createIssue).toHaveBeenCalledOnce();
  });

  it.each([
    ["draft-review", false],
    ["draft-review", true],
    ["auto-file", false],
  ] as const)("falls back to Issue after a disabled Discussion search in %s mode", async (reportMode, file) => {
    const client = {
      ...deps().client!,
      searchDiscussions: vi.fn().mockRejectedValue(new DiscussionsDisabledError("Runfusion", "Fusion")),
      searchIssues: vi.fn().mockResolvedValue([]),
    };
    const result = await runReportPipeline({ actionType: "feedback", userPrompt: "Report status needs clarity" }, deps({ projectSettings: { ...settings, reportMode }, client }), { file });
    expect(client.searchIssues).toHaveBeenCalled();
    if (file || reportMode === "auto-file") {
      expect(result).toMatchObject({ kind: "filed", destination: "issue" });
      expect(client.createIssue).toHaveBeenCalledOnce();
    } else {
      expect(result.kind).toBe("draft-ready");
      expect(client.createIssue).not.toHaveBeenCalled();
    }
  });

  it("falls back to an Issue after create reports disabled Discussions", async () => {
    const client = {
      ...deps().client!,
      searchDiscussions: vi.fn().mockResolvedValue([]),
      searchIssues: vi.fn().mockResolvedValue([]),
      createDiscussion: vi.fn().mockRejectedValue(new DiscussionsDisabledError("Runfusion", "Fusion")),
    };
    const result = await runReportPipeline({ actionType: "feedback", userPrompt: "Report status needs clarity" }, deps({ projectSettings: { ...settings, reportMode: "auto-file", reportDiscussionCategory: "DC_ideas" }, client }));
    expect(client.searchIssues).toHaveBeenCalled();
    expect(client.createIssue).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: "filed", destination: "issue" });
  });

  it("automatically endorses an open duplicate in auto-file mode", async () => {
    const client = {
      createIssue: vi.fn(),
      addIssueReaction: vi.fn(),
      commentOnIssue: vi.fn().mockResolvedValue({ url: "https://github.com/Runfusion/Fusion/issues/9#issuecomment-9" }),
      searchIssues: vi.fn().mockResolvedValue([{ number: 9, title: "dashboard rendering controls", body: "dashboard rendering controls", html_url: "https://github.com/Runfusion/Fusion/issues/9", state: "open" }]),
    };
    const artifactId = "123e4567-e89b-42d3-a456-426614174000";
    const result = await runReportPipeline({
      actionType: "idea",
      userPrompt: "Add dashboard rendering controls",
      activityTrace: ["private-project /Users/alice/private-project ghp_abcdefghijk1234567890"],
      screenshotArtifactId: artifactId,
    }, deps({ projectSettings: { ...settings, reportMode: "auto-file" }, client }));
    expect(result.kind).toBe("endorsed");
    expect(String(client.commentOnIssue.mock.calls[0][3])).toContain(`artifact ${artifactId}`);
    expect(String(client.commentOnIssue.mock.calls[0][3])).not.toMatch(/private-project|\/Users\/alice|ghp_/);
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
    const artifactId = "123e4567-e89b-42d3-a456-426614174000";
    const result = await runReportPipeline({
      actionType: "feedback",
      userPrompt: "report flow status feedback",
      activityTrace: ["private-project /Users/alice/private-project sk-abcdefghijklmnopqrstuvwxyz"],
      screenshotArtifactId: artifactId,
    }, deps({ projectSettings: { ...settings, reportMode: "auto-file" }, client }));
    expect(result.kind).toBe("endorsed");
    expect(String(client.commentOnDiscussion.mock.calls[0][1])).toContain(`artifact ${artifactId}`);
    expect(String(client.commentOnDiscussion.mock.calls[0][1])).not.toMatch(/private-project|\/Users\/alice|sk-/);
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


  /*
   * FNXC:ReportPipeline 2026-07-19-20:45:
   * All report action types share one scrubbed artifact-reference contract.
   * Unknown client input must not become GitHub-visible context.
   */
  it.each(["bug", "feedback", "idea", "help"] as const)("carries scrubbed trace and an optional screenshot reference for %s drafts", async (actionType) => {
    const artifactId = "123e4567-e89b-42d3-a456-426614174000";
    const result = await runReportPipeline({
      actionType,
      userPrompt: "report capture regression",
      activityTrace: ["private-project /Users/alice/private-project ghp_abcdefghijk1234567890"],
      screenshotArtifactId: artifactId,
      ignoredClientField: "must not be forwarded",
    } as never, deps());

    expect(result).toMatchObject({ kind: "draft-ready", report: { screenshotArtifactId: artifactId } });
    if (result.kind === "draft-ready") {
      expect(result.report.context).toMatchObject({ actionType, activityTrace: [expect.not.stringMatching(/private-project|\/Users\/alice|ghp_/)] });
      expect(result.report.body).toContain(`artifact ${artifactId}`);
      expect(JSON.stringify(result.report)).not.toContain("must not be forwarded");
    }
  });

  /*
   * FNXC:ReportPipeline 2026-07-20-09:30:
   * Fresh and duplicate egress must consume the same scrubbed structured body
   * for both GitHub destinations, so a trace/reference cannot bypass privacy
   * handling after the draft stage.
   */
  it.each([
    ["fresh Issue", "bug", {}, "createIssue", 0],
    ["fresh Discussion", "feedback", { reportDiscussionCategory: "DC_ideas" }, "createDiscussion", 3],
  ] as const)("sends a scrubbed trace and screenshot reference through %s", async (_path, actionType, clientOverrides, egressMethod, bodyIndex) => {
    const client = { ...deps().client!, ...clientOverrides };
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file", reportDiscussionCategory: "DC_ideas" }, client });
    const artifactId = "123e4567-e89b-42d3-a456-426614174000";

    const result = await runReportPipeline({
      actionType,
      userPrompt: "report capture regression",
      activityTrace: ["private-project /Users/alice/private-project ghp_abcdefghijk1234567890 sk-abcdefghijklmnopqrstuvwxyz"],
      screenshotArtifactId: artifactId,
    }, context);
    expect(result).toMatchObject({ kind: expect.stringMatching(/filed|endorsed/) });

    const call = (client[egressMethod] as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = egressMethod === "createIssue" ? String(call[0].body) : String(call[bodyIndex]);
    expect(body).toContain(`artifact ${artifactId}`);
    expect(body).not.toMatch(/private-project|\/Users\/alice|ghp_|sk-/);
  });

  it("omits a non-opted-in screenshot while retaining scrubbed trace in auto-file mode", async () => {
    const context = deps({ projectSettings: { ...settings, reportMode: "auto-file" } });
    const result = await runReportPipeline({
      actionType: "bug",
      userPrompt: "report capture regression",
      activityTrace: ["private-project /Users/alice/private-project sk-abcdefghijklmnopqrstuvwxyz"],
    }, context);

    expect(result).toMatchObject({ kind: "filed", report: { screenshotArtifactId: undefined } });
    if (result.kind === "filed") expect(JSON.stringify(result.report)).not.toMatch(/private-project|\/Users\/alice|sk-/);
    expect(context.client!.createIssue).toHaveBeenCalledWith(expect.objectContaining({ body: expect.not.stringContaining("## Screenshot") }));
  });
});
