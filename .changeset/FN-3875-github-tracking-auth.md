---
"@runfusion/fusion": patch
---

GitHub tracking lifecycle now strictly honors the project-level `githubAuthMode`. Token mode requires `githubAuthToken` (or `GITHUB_TOKEN`); gh-cli mode requires an authenticated `gh` CLI. The previous opportunistic fallback no longer applies to tracking issue creation/comments/state sync flows (legacy PR/import flows are unchanged).
