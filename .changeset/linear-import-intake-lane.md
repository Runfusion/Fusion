---
"@runfusion/fusion": patch
---

summary: Linear imports now land on the board instead of a lane that no longer exists.
category: fix
dev: `buildLinearTaskCreateInput` passed `column: "triage"`, a column U11 deleted, and an explicit column overrides `createTask`'s own intake resolution — so every imported issue was written into a lane no workflow declares. It now omits `column`. Same defect and same fix as the GitLab importer (#2843); the two tests that pinned `"triage"` now assert the column is absent.
