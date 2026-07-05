---
"@runfusion/fusion": patch
---

summary: Fix branch group completion checklists to show accurate landed/finished counts.
category: fix
dev: runAiMerge (the sole merge path since master-plan U0) never resolved branch-group routing or stamped mergeDetails.mergeTargetBranch/mergeTargetSource, so isBranchGroupMemberLanded permanently reported shared-group members as not landed. Routes through resolveBranchGroupMergeRouting (matching the legacy merger.ts pattern) and stamps the target fields on both the landed and no-op finalize paths; preserves merge-target-safety in isBranchGroupMemberLanded (a sibling/mismatched-branch member still never counts as landed).
