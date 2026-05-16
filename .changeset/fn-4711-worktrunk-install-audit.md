---
"@runfusion/fusion": patch
---

Emit `worktree:worktrunk-install` run-audit events on successful worktrunk auto-install (release-binary or cargo paths), completing the worktrunk audit taxonomy started in FN-4626. Cache hits, `$PATH` resolutions, and `worktrunk.binaryPath` overrides remain silent.
