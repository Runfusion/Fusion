# Standalone Fusion remote agents

These Python 3 standard-library collectors read native Codex and Claude JSONL files. They talk directly to Fusion. AgentPulse, its API, database, relay, supervisor and hooks are not dependencies.

Fusion requires PostgreSQL and one independently generated collector token per host/project. Add only SHA-256 token digests to the private dashboard environment:

```json
FUSION_EXTERNAL_SESSION_COLLECTORS=[{"projectId":"PROJECT_ID","hostId":"HOST_ID","tokenSha256":"TOKEN_SHA256"}]
```

Save the matching raw token in a mode `0600` file on the corresponding host. Never commit tokens or state. Use HTTPS, a private loopback tunnel, or plain HTTP only inside a private network you control, restricted to the collector hosts' source addresses. Existing public dashboard authentication remains required for viewing and composing feedback; collector tokens authorize only the four exact POST ingestion, heartbeat, feedback-claim and feedback-ack endpoints. They cannot read other hosts or projects.

```sh
python3 collector.py --url https://fusion.example.com --project PROJECT_ID --host HOST_ID \
  --token-file /private/path/token --state /private/path/spool.sqlite
```

Keep this process running under the host's normal service manager. The collector checks native files modified in the last seven days, bounded to 2,000 files per scan. `--home` selects the native CLI user's home. It reads complete lines incrementally, keeps a private durable spool, resumes after outages and never resets an ambiguous replaced/truncated file automatically. Its own SQLite ledger is local transport state; canonical session and feedback storage is Fusion's PostgreSQL database.

Install feedback hooks independently of any other hook integrations:

```sh
python3 install_hooks.py --url https://fusion.example.com --project PROJECT_ID --host HOST_ID \
  --token-file /private/path/token --state /private/path/spool.sqlite
# Review the target paths, then repeat with --apply.
```

The installer backs up existing settings. Route changes update matching plain Fusion commands for the same script, project, host, provider and spool, and remove duplicate owned invocations rather than appending another copy. Other hooks, shell wrappers and native trust decisions are preserved. Codex requires its hooks feature and native review/trust of the new command definitions. Restart/resume Claude sessions to load changed settings. Until a native hook actually registers a live runtime, Fusion displays feedback as unsupported.

Plain HTTP is accepted only for `localhost`, a literal private, loopback or link-local address, or a hostname you list in `FUSION_REMOTE_AGENTS_HTTP_HOSTS` (comma-separated). Everything else must use HTTPS. Point the collector and the feedback hooks at the same URL; rerunning the installer with a new `--url` updates the owned hook commands in place. If you expose Fusion to collectors through a relay, bind it only to the private interface, restrict it to the collector hosts, and leave the dashboard's normal authentication in front of any public route.

To roll back a network change, stop the collector, restore the previous collector and hook URL, validate that endpoint, then restart the collector. Keep its durable spool, token file, other hooks and native trust decisions. Application and database rollback is a separate, consistent-snapshot procedure.

Feedback is queued for five minutes and delivered as additional context at the next supported native hook. Resuming a session rotates its generation; old-generation feedback cannot enter the resumed runtime. Delivery acknowledges emitted native context, not proof that the agent acted on it. Ambiguous delivery is shown as uncertain and is never automatically replayed.

Open Fusion's **Agents → Remote agents**, select the configured project and a session. Collector connectivity and activity age are shown separately. Cost uses Fusion's recorded model/category pricing and shows its provenance. Claude's one-hour writes use its documented 2x input tariff, separately from five-minute writes. Unknown usage, models and unsupported fast/long-context pricing remain unavailable rather than becoming zero. Reported reasoning tokens are included in output tokens and are not charged twice. Partial known cost is labeled separately.

Agent launching/stopping/resuming, templates, notes/pins, transcript search, patches, AI summaries/watchers, rankings, notifications and historical AgentPulse migration are outside this implementation.

## Delivery speed

A finished turn normally reaches Fusion within about a second:

- The collector scans before it delivers, so a new turn ships in the same pass.
- The feedback hooks wake the collector through a private datagram socket next to its spool (`<state>.wake`). Claude's `Stop` event is registered for this wake only; it prints nothing and never contacts Fusion. Codex keeps its existing hook definitions, because each new one needs native review and trust. Without a hook the collector polls every five seconds.
- Turns go in batches of up to 50 (6 MiB) to `turn-ingest-batch`, with a result per turn, over one keep-alive connection per delivery round. A Fusion build without that route answers 404 (or 413 from its default body limit) and the collector sends turns singly, trying batches again every ten minutes, so collectors and Fusion can be upgraded in either order.
- Heartbeats go every 15 seconds; Fusion marks a host stale after 60.

## Contract and recovery

`emit_turns.py` prints every turn the parser would send for a transcript. Fusion's core test suite runs it over `fixtures/` and validates each turn against the server's strict zod contract, so the parser and the contract cannot drift apart unnoticed. When they did drift in production, Fusion refused the affected turns and collectors set them aside as delivered. `repair_spool.py --state <spool>` reports what it would recover from such an incident; stop the collector, rerun it with `--apply`, then start the collector to redeliver.

`deploy/` holds a launchd agent and a systemd user unit with placeholders for running the collector as a service.

Run the native protocol tests with `python3 -m unittest discover -s scripts/remote-agents -p 'test_*.py'` and the cross-language contract test with `pnpm --filter @fusion/core exec vitest run src/__tests__/external-session-collector-contract.test.ts`. `pnpm smoke:external-sessions` exercises the real isolated Fusion HTTP ingest/read/pricing/feedback/restart flow without AgentPulse.
