import { isValidTaskBranchName } from "@fusion/core";
import { deriveJiraBranchName, normalizeJiraIssueKey } from "@fusion/engine";
import { badRequest } from "../api-error.js";
import { resolveJiraAuth } from "../jira-auth.js";
import { JiraApiError, JiraClient } from "../jira.js";
import type { ApiRoutesContext } from "./types.js";

/**
 * FNXC:JiraBranchNaming 2026-08-20-05:18:
 * FN-9165 returns recoverable derivation failures as 200/ok:false so operators retain a hand-typed
 * branch and task creation is never blocked. Upstream failures collapse to the declared network_error
 * reason rather than exposing transport-specific details or extending the dashboard response contract.
 */
export function registerJiraRoutes(ctx: ApiRoutesContext): void {
  ctx.router.post("/jira/derive-branch-name", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.issueKey !== "string") throw badRequest("issueKey is required");

      const issueKey = normalizeJiraIssueKey(body.issueKey);
      if (!issueKey) {
        return res.json({ ok: false, reason: "invalid_key", message: "Enter a valid JIRA issue key." });
      }

      const { store } = await ctx.getProjectContext(req);
      const auth = await resolveJiraAuth({
        store,
        projectSettings: await store.getSettings(),
        globalSettings: await store.getGlobalSettingsStore().getSettings(),
      });
      if (!auth.ok) return res.json(auth);

      let issue: { key: string; summary: string | null };
      try {
        issue = await new JiraClient(auth.auth).getIssueSummary(issueKey);
      } catch (error) {
        const upstreamReason = error instanceof JiraApiError ? error.message : "network_error";
        const reason = upstreamReason === "not_found" || upstreamReason === "unauthorized"
          ? upstreamReason
          : "network_error";
        return res.json({
          ok: false,
          reason,
          message: reason === "not_found"
            ? "JIRA issue was not found."
            : reason === "unauthorized"
              ? "JIRA authorization failed."
              : "JIRA is unavailable. Try again later.",
        });
      }

      const derived = deriveJiraBranchName({
        issueKey,
        summary: issue.summary,
        template: typeof body.template === "string" ? body.template : undefined,
      });
      if (!derived.ok) return res.json(derived);
      if (!isValidTaskBranchName(derived.branchName)) {
        return res.json({ ok: false, reason: "invalid_branch_name", message: "Derived branch name is not a valid Git ref." });
      }
      return res.json({ ok: true, branchName: derived.branchName, issueKey, summary: issue.summary });
    } catch (error) {
      next(error);
    }
  });
}
