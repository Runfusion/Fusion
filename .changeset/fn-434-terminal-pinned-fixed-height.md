---
"@runfusion/fusion": patch
---

summary: Pinned terminal now has a fixed height, detaches when dragged, and re-pins on footer contact.
category: fix
dev: Removes the pinned terminal resize gesture (its top-edge formula was inverted) and the `fusion:terminal-docked-height-<projectId>` preference, which is no longer read or written; a stored value is ignored, not migrated. The grip becomes a detach gesture (16px threshold), a completed move gesture bringing an unsnapped floating window's bottom edge onto the footer line re-pins it, and the live xterm element is re-attached to the current container on every presentation change.
