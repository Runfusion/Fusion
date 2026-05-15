---
"@runfusion/fusion": patch
---

Fix stale "files changed" counts on done task cards. The `/api/tasks/:id/diff`
endpoint and the TaskCard done-task badge no longer fall back to the stored
`task.mergeDetails.filesChanged` value, which can be stale after a rebase-and-
push (see FN-4526). The endpoint now always derives stats from a live
`git show --shortstat <commitSha>` when a merge SHA is resolvable, and the
TaskCard treats the endpoint's response — including `0` — as authoritative.
The stored `mergeDetails.filesChanged` is shown only as a transient placeholder
while the live fetch is in flight.
