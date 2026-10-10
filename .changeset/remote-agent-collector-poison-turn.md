---
"@runfusion/fusion": patch
---

summary: A remote-agent collector no longer stalls behind a turn Fusion refuses, or reports a turn ending before it starts.
category: fix
dev: Parser `_finish` leaves `endedAt` unknown (and keeps only a native duration) when a completion predates the prompt; `drain_turns` sets aside a turn rejected with 400/409/413/422 and counts `rejected_turns`, while auth, 404, 429 and 5xx still block and retry.
