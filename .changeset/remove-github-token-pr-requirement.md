---
"@gsxdsm/fusion": patch
---

Remove the `GITHUB_TOKEN` requirement for PR creation and related GitHub task-import workflows, using `gh auth login` as the primary authentication path in CLI and extension flows.