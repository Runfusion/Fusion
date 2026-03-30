---
"@dustinbyrne/kb": patch
---

Simplify GitHub import modal by removing manual owner/repo input fields

The GitHub import modal now relies solely on git remote detection:
- Single remote: automatically selected and displayed as read-only text
- Multiple remotes: clean dropdown for selection
- No remotes: helpful message with instructions to add a remote

This reduces UI clutter and prevents confusion between manual entry and remote selection.
