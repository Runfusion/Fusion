---
"@runfusion/fusion": minor
---

Add the CLI Agent Executor hook ingestion route and per-session hook scripts
(U17). The dashboard now serves a localhost-only `POST /api/cli-agent/hooks`
endpoint that authenticates per-session hook POSTs from a spawned CLI agent and
forwards the validated payload in-process to the engine telemetry hub (the engine
has no HTTP server — only the dashboard serves HTTP).

The route is hardened because localhost is not a trust boundary: it validates the
high-entropy per-session token against the engine-held registry (a session id
alone is never sufficient, and a token for one session never validates for
another), rejects browser-context requests via Origin/Host CSRF checks, caps the
payload size, and treats an unknown/non-live session as a 200 no-op rather than a
crash. It is exempt from the daemon bearer-token middleware (hook scripts only
hold the per-session token) but authenticates with that token instead.

The engine gains `hook-scripts.ts`: it generates the per-session hook script and
notify shim (Orca `agent-hooks` shape — `curl` POST of the stdin JSON with the
session token header, short timeouts, always exit 0), writes them into a
session-scoped config dir (owner-only, executable), and deletes that dir on
session end (the token is registry-invalidated at the same moment, bounding its
at-rest exposure to the session lifetime).
