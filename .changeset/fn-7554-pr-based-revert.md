---
"@runfusion/fusion": minor
---

summary: Open a revert PR for done/archived tasks when autoMerge is disabled instead of refusing.
category: feature
dev: `POST /api/tasks/:id/revert` gains an additive `{ mode: "pr", clean: true, prUrl, prNumber, revertBranch, existingPr? }` result for clean single-repo reverts under `autoMerge:false`, reusing `GitHubClient.createPr`, `findPrForBranch` idempotency, and the `manual:true` PR handoff. New engine export `prepareRevertPrBranch` (packages/engine/src/task-revert.ts) prepares the dedicated `fusion/revert-<id>` branch without ever mutating the base branch. Existing `{ mode: "git" | "ai", ... }` shapes and the `autoMerge:true` path are unchanged.
