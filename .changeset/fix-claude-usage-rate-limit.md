---
"@gsxdsm/fusion": patch
---

Fix Claude usage indicator always showing "Rate limited" by removing outdated anthropic-beta header and adding retry logic with exponential backoff for transient 429 responses.
