---
"@runfusion/fusion": minor
"runfusion.ai": minor
"@fusion/core": minor
"@fusion/dashboard": minor
"@fusion/desktop": minor
"@fusion/engine": minor
"@fusion/mobile": minor
"@fusion/pi-claude-cli": minor
"@fusion/plugin-sdk": minor
---

Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.
