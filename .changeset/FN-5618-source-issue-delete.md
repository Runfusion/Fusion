---
"@runfusion/fusion": patch
---

Close source-imported GitHub issues when their linked Fusion task is deleted, with parity to tracking-issue delete handling. Dashboard delete confirmation now prompts for `close`, `delete`, or `leave` on source-imported issues and forwards `githubIssueAction` through task deletion flows. For API callers that omit `githubIssueAction` (or send `auto`) on source-imported issue deletes, Fusion now defaults to `close`.
