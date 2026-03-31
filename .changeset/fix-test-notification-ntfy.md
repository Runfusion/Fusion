---
"@dustinbyrne/kb": patch
---

Fix test notification feature to use current form values instead of saved settings

Previously, clicking "Test notification" in settings would fail with a 400 error if ntfy was enabled in the form but not yet saved. The test notification now correctly uses the current form values (ntfyEnabled, ntfyTopic) when available, falling back to stored settings for backward compatibility.
