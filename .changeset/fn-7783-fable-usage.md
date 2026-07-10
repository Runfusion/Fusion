---
"@runfusion/fusion": minor
---

summary: Show a Claude "Weekly (Fable)" usage window in the Usage dropdown.
category: feature
dev: usage.ts fetchClaudeUsage parses seven_day_fable (with tolerant fallback keys) and fetchClaudeUsageViaCli adds a "Current week (Fable" section; frontend renders it generically. API field name assumed seven_day_fable.
