import type { GlobalSettings, ProjectSettings, ReportActionType, ReportMode } from "@fusion/core";
import { resolveTaskGithubTracking } from "@fusion/core";
import { GitHubClient } from "./github.js";
import { resolveGithubTrackingAuth } from "./github-auth.js";
import { buildIssueSearchQueries, DEDUP_MATCH_THRESHOLD, scoreCandidateIssue } from "./github-tracking-dedup.js";
import { scrubReportPayload, type ReportScrubContext } from "./report-scrub.js";
import type { RoadmapDedupSource } from "./report-roadmap-source.js";

export type { ReportActionType, ReportMode };

export interface ReportActivityTraceEntry {
  ts: string;
  kind: string;
  label: string;
}

export interface ReportInput {
  actionType: ReportActionType;
  userPrompt: string;
  contextRefs?: { taskId?: string; agentId?: string };
  activityTrace?: ReportActivityTraceEntry[];
  screenshotArtifactId?: string;
}

export interface StructuredReport {
  userPrompt: string;
  /** The prompt from which the displayed derived fields were generated. */
  sourcePrompt?: string;
  summary: string;
  body: string;
  context: Record<string, unknown>;
  sessionToken?: string;
}

export type ReportResult =
  | { kind: "draft-ready"; report: StructuredReport; mode: ReportMode }
  | { kind: "duplicate-found"; report: StructuredReport; mode: ReportMode; issue: { number: number; url: string; title: string; discussionId?: string } }
  | { kind: "roadmap-match"; report: StructuredReport; mode: ReportMode; roadmap: { featureId: string; title: string; description: string } }
  | { kind: "filed"; url: string; report: StructuredReport }
  | { kind: "endorsed"; url: string; issueNumber: number; report: StructuredReport }
  | { kind: "unavailable"; reason: string; message: string };

export interface ReportPipelineDeps {
  projectSettings: Pick<ProjectSettings, "reportMode" | "reportModeByAction" | "reportRoadmapDedup" | "githubTrackingDefaultRepo" | "githubAuthMode" | "githubAuthToken">;
  globalSettings?: Partial<GlobalSettings>;
  client?: Pick<GitHubClient, "createIssue" | "searchIssues" | "commentOnIssue" | "addIssueReaction"> & Partial<Pick<GitHubClient, "searchDiscussions" | "createDiscussion" | "commentOnDiscussion" | "addDiscussionReaction">>;
  scrubContext?: ReportScrubContext;
  gatherContext?: (input: ReportInput) => Promise<Record<string, unknown>>;
  roadmapSource?: RoadmapDedupSource;
}

const MAX_PROMPT_LENGTH = 4_000;
/*
FNXC:ReportPipeline 2026-07-16-10:45:
Screenshot capture remains a per-report, off-by-default user choice rather than
project policy. Activity trace is default-on client context because it is bounded
and scrubbed; no persisted settings are needed for either behavior.
*/
const endorsedSessions = new Map<string, { url: string; issueNumber: number }>();

export function resolveReportMode(actionType: ReportActionType, settings: ReportPipelineDeps["projectSettings"]): ReportMode {
  return settings.reportModeByAction?.[actionType] ?? settings.reportMode ?? "draft-review";
}

function requirePrompt(input: ReportInput): string {
  const prompt = input.userPrompt.trim();
  if (!prompt) throw new Error("A report description is required.");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Report descriptions must be at most ${MAX_PROMPT_LENGTH} characters.`);
  return prompt;
}

function formatContext(context: Record<string, unknown>): string {
  return Object.entries(context)
    .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n") || "- No additional context collected";
}

function expectedBehavior(actionType: ReportActionType): string {
  switch (actionType) {
    case "bug": return "The affected feature should complete its normal, documented behavior.";
    case "idea": return "The suggested improvement should be considered as a product capability.";
    case "feedback": return "The experience should support the described workflow without the reported friction.";
    case "help": return "The product documentation or interface should make the requested workflow clear.";
  }
}

function structureReport(input: ReportInput, gathered: Record<string, unknown>): StructuredReport {
  const prompt = requirePrompt(input);
  // FNXC:ReportPipeline 2026-07-16-09:00:
  // Activity trace is ordinary text context. It must continue through
  // scrubReportPayload with every other report field before GitHub egress.
  const context = { actionType: input.actionType, ...gathered, ...input.contextRefs, ...(input.activityTrace?.length ? { activityTrace: input.activityTrace } : {}) };
  const formattedContext = formatContext(context);
  return {
    userPrompt: prompt,
    sourcePrompt: prompt,
    summary: `[${input.actionType}] ${prompt.slice(0, 120)}`,
    body: `## Summary\n${prompt}\n\n## Reproduction / context\n${formattedContext}\n\n## Expected behavior\n${expectedBehavior(input.actionType)}\n\n## Actual behavior / request\n${prompt}\n\n## Environment\n${formattedContext}`,
    context,
    sessionToken: crypto.randomUUID(),
  };
}

function createClient(deps: ReportPipelineDeps): { client?: ReportPipelineDeps["client"]; unavailable?: Extract<ReportResult, { kind: "unavailable" }> } {
  if (deps.client) return { client: deps.client };
  const resolution = resolveGithubTrackingAuth({ projectSettings: deps.projectSettings, globalSettings: deps.globalSettings });
  if (!resolution.ok) return { unavailable: { kind: "unavailable", reason: resolution.reason, message: resolution.message } };
  return { client: resolution.auth.mode === "token" ? new GitHubClient({ token: resolution.auth.token, forceMode: "token" }) : new GitHubClient({ forceMode: "gh-cli" }) };
}

function resolveRepo(deps: ReportPipelineDeps) {
  return resolveTaskGithubTracking({ githubTracking: undefined }, deps.projectSettings, deps.globalSettings).repo;
}

type ReportDestination = "issue" | "discussion";
type DuplicateCandidate = { number: number; title: string; body: string | null; html_url: string; state: "open" | "closed"; discussionId?: string };

function destinationFor(actionType: ReportActionType): ReportDestination {
  return actionType === "feedback" || actionType === "help" ? "discussion" : "issue";
}

function reportKeywords(report: StructuredReport): string[] {
  return report.summary.replace(/[^\w ]/g, " ").split(/\s+/).filter((word) => word.length > 3).slice(0, 6);
}

async function findDuplicate(client: NonNullable<ReportPipelineDeps["client"]>, owner: string, repo: string, report: StructuredReport, destination: ReportDestination) {
  const keywords = reportKeywords(report);
  for (const query of buildIssueSearchQueries([], keywords)) {
    const candidates: DuplicateCandidate[] = destination === "discussion"
      ? (client.searchDiscussions ? await client.searchDiscussions(owner, repo, query, { limit: 1000 }) : []).map((discussion) => ({ number: discussion.number, title: discussion.title, body: discussion.body, html_url: discussion.url, state: discussion.state, discussionId: discussion.id }))
      : await client.searchIssues(owner, repo, query, { state: "open", limit: 20 });
    const match = candidates.filter((candidate) => candidate.state === "open")
      .map((candidate) => ({ candidate, score: scoreCandidateIssue(candidate, [], keywords).score }))
      .find(({ score }) => score >= DEDUP_MATCH_THRESHOLD);
    if (match) return match.candidate;
  }
  return undefined;
}

export async function findRoadmapMatch(roadmapSource: RoadmapDedupSource, report: StructuredReport) {
  const keywords = reportKeywords(report);
  const candidates = await roadmapSource(keywords);
  const match = candidates
    .map((candidate) => ({ candidate, score: scoreCandidateIssue(candidate, [], keywords).score }))
    .filter(({ score }) => score >= DEDUP_MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score)[0];
  return match?.candidate;
}

async function endorseDiscussionDuplicate(args: { issueNumber: number; discussionId: string; report: StructuredReport; client: NonNullable<ReportPipelineDeps["client"]> & Pick<GitHubClient, "commentOnDiscussion" | "addDiscussionReaction">; scrubContext?: ReportScrubContext }): Promise<Extract<ReportResult, { kind: "endorsed" }>> {
  const sessionToken = args.report.sessionToken ?? `${args.discussionId}:${args.report.summary}`;
  const report = scrubReportPayload(args.report, args.scrubContext);
  const existing = endorsedSessions.get(sessionToken);
  if (existing) return { kind: "endorsed", ...existing, report };
  /*
  FNXC:ReportPipeline 2026-07-18-11:15:
  Discussion duplicates receive the same +1 and scrubbed data-point contract
  as Issue duplicates. This keeps Feedback and Help dedupe visibly useful.
  */
  await args.client.addDiscussionReaction(args.discussionId);
  const comment = await args.client.commentOnDiscussion(args.discussionId, `## Additional Fusion report data point\n\n${report.body}`);
  const result = { url: comment.url, issueNumber: args.issueNumber };
  endorsedSessions.set(sessionToken, result);
  return { kind: "endorsed", ...result, report };
}

export async function endorseDuplicate(args: { owner: string; repo: string; issueNumber: number; report: StructuredReport; client: NonNullable<ReportPipelineDeps["client"]>; scrubContext?: ReportScrubContext }): Promise<Extract<ReportResult, { kind: "endorsed" }>> {
  const sessionToken = args.report.sessionToken ?? `${args.issueNumber}:${args.report.summary}`;
  const existing = endorsedSessions.get(sessionToken);
  const report = scrubReportPayload(args.report, args.scrubContext);
  if (existing) return { kind: "endorsed", ...existing, report };
  /*
  FNXC:ReportPipeline 2026-07-16-18:00:
  A confirmed open duplicate must strengthen its existing thread rather than
  create another issue. Add the visible +1 signal and the scrubbed data point
  together, while the session token prevents retries from multiplying either.
  */
  await args.client.addIssueReaction(args.owner, args.repo, args.issueNumber, "+1");
  const comment = await args.client.commentOnIssue(args.owner, args.repo, args.issueNumber, `## Additional Fusion report data point\n\n${report.body}`);
  const url = typeof comment === "object" && comment && "url" in comment && typeof comment.url === "string"
    ? comment.url
    : `https://github.com/${args.owner}/${args.repo}/issues/${args.issueNumber}`;
  const result = { url, issueNumber: args.issueNumber };
  endorsedSessions.set(sessionToken, result);
  return { kind: "endorsed", ...result, report };
}

function normalizeSubmittedReport(input: ReportInput, gathered: Record<string, unknown>, submitted: StructuredReport | undefined): StructuredReport {
  const structured = structureReport(input, gathered);
  if (!submitted) return structured;

  const userPrompt = requirePrompt({ ...input, userPrompt: submitted.userPrompt || input.userPrompt });
  const rebuilt = structureReport({ ...input, userPrompt }, gathered);
  const promptChangedSinceDerivation = typeof submitted.sourcePrompt === "string" && submitted.sourcePrompt !== userPrompt;

  // FNXC:ReportPipeline 2026-07-16-17:15:
  // A draft's summary and body are derived from its guided prompt. Rebuild them
  // when that prompt changed after drafting, while preserving intentional edits
  // made to fields derived from the same prompt.
  return {
    userPrompt,
    sourcePrompt: userPrompt,
    summary: !promptChangedSinceDerivation && typeof submitted.summary === "string" && submitted.summary.trim() ? submitted.summary : rebuilt.summary,
    body: !promptChangedSinceDerivation && typeof submitted.body === "string" && submitted.body.trim() ? submitted.body : rebuilt.body,
    context: submitted.context && typeof submitted.context === "object" ? { ...rebuilt.context, ...submitted.context } : rebuilt.context,
    sessionToken: typeof submitted.sessionToken === "string" && submitted.sessionToken ? submitted.sessionToken : rebuilt.sessionToken,
  };
}

export async function runReportPipeline(input: ReportInput, deps: ReportPipelineDeps, options: { file?: boolean; endorseIssueNumber?: number; endorseDiscussionId?: string; report?: StructuredReport } = {}): Promise<ReportResult> {
  const gathered = await deps.gatherContext?.(input) ?? { taskId: input.contextRefs?.taskId, agentId: input.contextRefs?.agentId };
  let report = scrubReportPayload(normalizeSubmittedReport(input, gathered, options.report), deps.scrubContext);
  if (input.screenshotArtifactId) {
    // FNXC:ReportPipeline 2026-07-16-10:30:
    // The route has validated this reference before pipeline entry. Rebuild the
    // text-only local-retention note here so edited drafts cannot omit it and
    // image bytes never cross the GitHub boundary.
    const note = `Screenshot captured and retained locally (artifact ${input.screenshotArtifactId}).`;
    if (!report.body.includes(note)) report = { ...report, body: `${report.body}\n\n${note}` };
  }
  const mode = resolveReportMode(input.actionType, deps.projectSettings);
  /*
  FNXC:ReportPipeline 2026-07-18-12:30:
  An opted-in roadmap hit takes deterministic precedence over GitHub matching
  and filing. It returns local roadmap context only, so no issue, discussion,
  comment, reaction, or other external egress can occur in either report mode.
  */
  if (deps.projectSettings.reportRoadmapDedup && deps.roadmapSource) {
    const roadmap = await findRoadmapMatch(deps.roadmapSource, report);
    if (roadmap) return {
      kind: "roadmap-match",
      report,
      mode,
      roadmap: { featureId: roadmap.featureId, title: roadmap.title, description: roadmap.body ?? "" },
    };
  }
  const clientResult = createClient(deps);
  if (clientResult.unavailable) return clientResult.unavailable;
  const repo = resolveRepo(deps);
  if (!repo || !clientResult.client) return { kind: "unavailable", reason: "repo_missing", message: "Configure a GitHub tracking repository before filing reports." };
  // FNXC:ReportPipeline 2026-07-16-17:15:
  // A browser-provided issue number is not authorization to comment. Re-run
  // open-only matching immediately before endorsement so callers cannot post
  // arbitrary data to closed or unrelated issues.
  const destination = destinationFor(input.actionType);
  const duplicate = await findDuplicate(clientResult.client, repo.owner, repo.repo, report, destination);
  if (options.endorseDiscussionId) {
    if (!clientResult.client.commentOnDiscussion || !clientResult.client.addDiscussionReaction || destination !== "discussion" || duplicate?.discussionId !== options.endorseDiscussionId) {
      return { kind: "unavailable", reason: "duplicate_not_verified", message: "The selected discussion is no longer an open matching report. Please prepare the report again." };
    }
    return endorseDiscussionDuplicate({ issueNumber: duplicate.number, discussionId: duplicate.discussionId, report, client: clientResult.client as NonNullable<ReportPipelineDeps["client"]> & Pick<GitHubClient, "commentOnDiscussion" | "addDiscussionReaction">, scrubContext: deps.scrubContext });
  }
  if (options.endorseIssueNumber) {
    if (destination !== "issue" || duplicate?.number !== options.endorseIssueNumber) {
      return { kind: "unavailable", reason: "duplicate_not_verified", message: "The selected issue is no longer an open matching report. Please prepare the report again." };
    }
    return endorseDuplicate({ owner: repo.owner, repo: repo.repo, issueNumber: duplicate.number, report, client: clientResult.client, scrubContext: deps.scrubContext });
  }
  if (duplicate) {
    // FNXC:ReportPipeline 2026-07-16-16:30:
    // Auto-file promises a zero-friction result for every dedupe outcome, so a
    // strong open match receives the scrubbed data point automatically.
    if (mode === "auto-file") {
      if (destination === "discussion") {
        if (!duplicate.discussionId || !clientResult.client.commentOnDiscussion || !clientResult.client.addDiscussionReaction) {
          return { kind: "unavailable", reason: "discussion_unsupported", message: "This GitHub connection cannot endorse discussions." };
        }
        return endorseDiscussionDuplicate({ issueNumber: duplicate.number, discussionId: duplicate.discussionId, report, client: clientResult.client as NonNullable<ReportPipelineDeps["client"]> & Pick<GitHubClient, "commentOnDiscussion" | "addDiscussionReaction">, scrubContext: deps.scrubContext });
      }
      return endorseDuplicate({ owner: repo.owner, repo: repo.repo, issueNumber: duplicate.number, report, client: clientResult.client, scrubContext: deps.scrubContext });
    }
    return { kind: "duplicate-found", report, mode, issue: { number: duplicate.number, url: duplicate.html_url, title: duplicate.title, discussionId: duplicate.discussionId } };
  }
  if (!options.file && mode === "draft-review") return { kind: "draft-ready", report, mode };
  if (destination === "discussion") {
    if (!clientResult.client.createDiscussion) return { kind: "unavailable", reason: "discussion_unsupported", message: "This GitHub connection cannot create discussions." };
    const created = await clientResult.client.createDiscussion(repo.owner, repo.repo, report.summary, report.body);
    return { kind: "filed", url: created.htmlUrl, report };
  }
  const created = await clientResult.client.createIssue({ owner: repo.owner, repo: repo.repo, title: report.summary, body: report.body, labels: ["community"] });
  return { kind: "filed", url: created.htmlUrl, report };
}
