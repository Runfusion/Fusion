---
"@runfusion/fusion": patch
---

summary: Fix an unregistered built-in workflow id being trusted as a real selection.
category: fix
dev: `resolveWorkflowIrById` substituted the default coding IR for an id that looks built-in but is not registered, without branding it as a fallback, so `resolveWorkflowIrForTaskWithProvenance` reported `source: "selection"` for it. Brands that substitution, and removes the redundant IR-id cross-check that ran after the marker check — the IR types declare no `id`, and when one is present it is the author's, unrelated to the store-minted `WF-NNN`.
