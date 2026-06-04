---
"@runfusion/fusion": patch
---

Fix in-review tasks showing other tasks' files in the "files changed" list. `baseCommitSha` was captured as `merge-base(HEAD, origin/main)` at task start, but task branches fork from local main — when local main was ahead by merged-but-unpushed task commits, the recorded base rewound past them, and after the post-merge rebase-and-push rewrote their SHAs the diff range permanently swept the predecessors' files into the new task's diff. The capture now measures against local main first (origin/main as fallback), matching the contamination-base sites.
