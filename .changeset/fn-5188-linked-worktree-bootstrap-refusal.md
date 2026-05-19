---
"@runfusion/fusion": patch
---

Refuse bootstrapping a nested Fusion project from a linked git worktree when the parent repository already has `.fusion/fusion.db`, and allow an explicit override with `FUSION_ALLOW_NESTED_PROJECT=1`.
