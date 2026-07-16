---
"@runfusion/fusion": minor
---

summary: GitHub import pages all open issues with Prev/Next; linked issues close when tasks reach Done.
category: feature
dev: The import picker (GitHubImportModal) fetches up to 300 open issues in one request and pages the result client-side at 30/page with Prev/Next controls and a page indicator; a truncation notice appears past the cap. NewTaskModal's reference picker limit rose 30→100. GitHubClient.listIssues now pages the REST path (per_page loop until limit/exhaustion, PR-filtering no longer stops paging early) and lifts the gh path's 100 cap (gh --limit paginates internally); gh-CLI label filtering fetches the full cap before client-side OR filtering. Separately, the GitHub-tracking reconcile sweep now isolates its three passes in runSweep so a throw in one pass no longer silently starves the others — previously a failure in the first pass disabled the entire close-on-Done backstop, leaving linked/imported issues open; failures are now logged instead of swallowed.
