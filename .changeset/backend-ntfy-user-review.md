---
"@gsxdsm/fusion": patch
---

Backend-driven ntfy notifications now work without dashboard UI presence. The `awaiting-user-review` event (triggered when agents hand off tasks to users for human review) is now fully supported: it appears in the NtfyNotifier backend, the Settings UI checkbox, and documentation. This ensures push notifications work even when users are away from the dashboard.
