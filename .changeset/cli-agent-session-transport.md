---
"@runfusion/fusion": minor
---

CLI agent session transport (U10): authenticated cli-sessions REST routes
(list, single-use session-scoped attach tickets, inject, confirm-advance), a
distinct `/api/cli-sessions/ws` WebSocket attach handler (daemon-token + Origin
allowlist + single-use ticket gate, scrollback replay then live byte frames,
ACK-credit flow control driving engine pause/resume, latest-active-client
resize, server-side read-only enforcement, input-source attribution), a
streaming-safe outbound output filter (`neutralizeTerminalOutput`) that strips
OSC 52 clipboard writes, non-http(s) OSC 8 hyperlink URIs, and device-status /
query sequences, and a throttled `cli:session:state` SSE event with
Last-Event-ID replay.
