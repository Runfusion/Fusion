---
"@runfusion/fusion": patch
---

summary: Fix Stash chat backfill naming the first project session folder bare "Fusion" instead of "Fusion — <project name>".
category: fix
dev: The manual store-chat-to-Stash backfill route omitted projectName from the capture metadata, so the first session-folder get-or-create (keyed by external_key fusion-<projectId>) locked in the bare fallback name and never renamed it. The route now resolves the central registry project name (best-effort) and forwards it, matching the live capture seam.
