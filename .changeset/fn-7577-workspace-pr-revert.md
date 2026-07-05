---
"@runfusion/fusion": minor
---

summary: Open one revert PR per sub-repo for workspace tasks when autoMerge is disabled.
category: feature
dev: `POST /api/tasks/:id/revert` gains an additive workspace `{ mode: "pr", clean: true, workspace: { repos: [{ repo, revertBranch, prUrl, prNumber, existingPr? }] } }` result for clean multi-repo reverts under `autoMerge:false`, extending FN-7554's single-repo `mode:"pr"` path. New engine export `prepareWorkspaceRevertPrBranches` (packages/engine/src/task-revert.ts) classifies every sub-repo first and only prepares a dedicated `fusion/revert-<id>` branch per sub-repo when all are clean/already-reverted (all-or-nothing at the branch-prep phase), never force-writing any sub-repo integration branch. The route resolves owner/repo and checks the rate limiter for every sub-repo before pushing/creating any PR, so GitHub-unconfigured/rate-limited cases degrade the whole task to `needsHuman` rather than opening a partial subset of PRs. Existing `{ mode: "git" | "ai" | "pr", ... }` shapes, the `autoMerge:true` workspace path, and FN-7554's single-repo path are unchanged.
