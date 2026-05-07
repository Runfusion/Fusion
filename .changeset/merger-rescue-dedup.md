---
"@runfusion/fusion": patch
---

Fix race-rescue stash duplicating the primary autostash. `git add -A && git stash create` registers a stash commit but does not clean the working tree, so the rescue loop's subsequent `snapshotDirtyFiles` saw the same files the primary stash already captured and stashed them again on every merger run. Now the rescue diffs current dirty paths against the primary stash's recorded path set and only rescues paths that weren't already captured, plus a tree-SHA equality check that drops any rescue whose tree exactly matches the primary.
