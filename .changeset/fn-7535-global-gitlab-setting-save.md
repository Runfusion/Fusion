---
"@runfusion/fusion": patch
---

summary: Fix the global GitLab integration setting not persisting when saved.
category: fix
dev: splitSettingsSave now diffs the five global GitLab keys (gitlabEnabled, gitlabInstanceUrl, gitlabApiBaseUrl, gitlabAuthToken, gitlabAuthTokenType) against scoped global initials only, never the project-effective merged initialValues, so a project override no longer suppresses a real global save.
