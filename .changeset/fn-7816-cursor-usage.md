---
"@runfusion/fusion": minor
---

summary: Show Cursor subscription usage in the Usage dropdown.
category: feature
dev: usage.ts adds fetchCursorUsage via Cursor Admin API POST https://api.cursor.com/teams/spend with Basic auth API_KEY:, resolving the Admin API key from documented env `CURSOR_ADMIN_API_KEY` (or `CURSOR_API_KEY` alias) before internal test/auth-storage fallbacks. It maps teamMemberSpend overallSpendCents/spendCents plus hardLimitOverrideDollars/monthlyLimitDollars and subscriptionCycleStart; fetchAllProviderUsage wraps it with withTimeout and no-auth demotion, while UsageIndicator maps "Cursor" to cursor-cli. No personal Cursor CLI usage endpoint confirmed; CLI session only supplies userEmail/subscriptionTier metadata.
