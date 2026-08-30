---
"@runfusion/fusion": patch
---

summary: A failed database query now says what went wrong instead of printing the whole SQL statement.
category: fix
dev: Drizzle wraps a query failure in an error whose `message` is `Failed query: <full statement> params: …` and whose `cause` is the `PostgresError` carrying the real reason (`column "x" does not exist`, `permission denied`, `connection terminated`). `rethrowAsApiError` reported `error.message` alone, so operator-facing surfaces showed a wall of column names with no reason — reported from the task chat and undiagnosable from the report itself. `startup-factory` had already grown a private chain walker for the same reason; it is now shared as `describeErrorChain` / `summarizeErrorForOperator` in `process/error-message.ts`. The inversion is keyed narrowly on the `Failed query:` wrapper: an application-authored message still leads (the API boundary contract and its tests are unchanged), and only the machine-generated frame is demoted to truncated context behind its cause.
