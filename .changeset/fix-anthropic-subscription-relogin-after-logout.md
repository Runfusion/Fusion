---
"@runfusion/fusion": patch
---

summary: Fix Claude/Anthropic subscription re-login showing "Login did not complete" after logging out.
category: fix
dev: Anthropic subscription OAuth is aliased across the legacy `anthropic` row (where interactive login persists the credential) and the `anthropic-subscription` id (where the settings card's in-memory logged-out suppression and status read are keyed). Re-login wrote only `anthropic`, so `loggedOutProviders` kept suppressing `anthropic-subscription` and the card reported failure despite a valid stored credential until process restart. auth-storage's proxy now clears the logged-out state on both aliases when either is re-authenticated (new `login` trap + hardened `set` trap via `clearReauthenticatedLogoutState`; raw api_key writes stay scoped to their own card). Also surfaces background OAuth login failures on `GET /auth/status` (`loginError`) + server logs so future paste-callback failures are diagnosable instead of a generic error.
