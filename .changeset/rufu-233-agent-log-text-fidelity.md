---
"@runfusion/fusion": patch
---

summary: Task logs stop duplicating a revised reply's opening words, and stop dropping a new reply that repeats them.
category: fix
dev: The capture seam's contradicting-block branch now separates the two shapes it receives. A REVISION of the block being streamed (contradiction at `text_delta`/`text_end`/`message_end`) hands an append-only sink only the text past the point where the block's new claim stops agreeing with what that sink already holds (`novelSpan`); a revision trimming back to an already-held prefix hands nothing and must not pull the ledger cursor down. A REPLACEMENT (a second `${kind}_start` for a block index already delivered inside the same message — one `partial` reused across replies with no `message_start`) restarts that block's ledger and is delivered whole regardless of length, because its head belongs to the previous reply and clipping it deletes a genuine new message. Byte-faithfulness from streamed delta to disk to read-back is pinned by new round-trip tests over a real `agent-log.jsonl` boundary plus heartbeat- and triage-lane fidelity tests; the falsified premise that the read route or the JSONL store deletes characters is documented in `docs/solutions/logic-errors/agent-log-read-route-is-append-free.md`.
