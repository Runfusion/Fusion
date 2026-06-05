---
"@runfusion/fusion": patch
---

Fix a batch of CLI Agent Executor review defects:

- **Schema-version gate**: bump `SCHEMA_VERSION` to 110 so a DB already at 109
  runs migration 110 and gains the `chat_sessions.cliExecutorAdapterId` column
  (it was previously short-circuited). Add the column to the compat-fingerprint
  `MIGRATION_ONLY_TABLE_SCHEMAS.chat_sessions` entry so the fingerprint matches.
- **Generic adapter double-wrap**: `formatInjection` no longer re-wraps injected
  text in bracketed-paste markers when `bracketedPasteActive`; the session
  manager's security path is the sole wrapper, so the generic adapter (like every
  native one) only appends a carriage return.
- **Output-filter cross-boundary bypass**: thread one carry buffer across the
  scrollback→live seam in the CLI session WS bridge so a dangerous escape (e.g.
  OSC 52) split across the seam is fully neutralized instead of the held
  introducer being flushed verbatim into the scrollback frame.
- **Output-filter overflow leak**: when an over-length carry begins with a
  recognized dangerous introducer (OSC `ESC ]` / DCS `ESC P`), drop the
  introducer instead of flushing it as literal, so it cannot recombine with a
  later terminator at the client.
- **Follow-up never resolves**: `followUp()` now drives the authoritative state
  machine `done→busy` before injecting, so the re-armed result promise resolves
  on the next positive `done` instead of hanging on an idempotent done.
