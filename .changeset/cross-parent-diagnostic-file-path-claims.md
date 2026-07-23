---
"@runfusion/fusion": patch
---

summary: Duplicate follow-up tasks naming the same failing file now converge at creation across parent tasks.
category: fix
dev: `computeCrossParentDiagnosticClaim` gains file-path/slug fallback objects and wider action/failure gates (exceeds, oversized, blocks, "so X passes"); FN-8510/8511/8513/8514 incident.
