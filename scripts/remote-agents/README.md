# Standalone Fusion remote agents

These Python 3 standard-library collectors read native Codex and Claude JSONL files. They talk directly to Fusion. AgentPulse, its API, database, relay, supervisor and hooks are not dependencies.

Fusion requires PostgreSQL and one independently generated collector token per host/project. Add only SHA-256 token digests to the private dashboard environment:

```json
FUSION_EXTERNAL_SESSION_COLLECTORS=[{"projectId":"PROJECT_ID","hostId":"j","tokenSha256":"TOKEN_SHA256"}]
```

Save the matching raw token in a mode `0600` file on the corresponding host. Never commit tokens or state. Use HTTPS, a private loopback tunnel or an explicitly verified source-restricted WireGuard relay. Existing public dashboard authentication remains required for viewing and composing feedback; collector tokens authorize only the four exact POST ingestion, heartbeat, feedback-claim and feedback-ack endpoints. They cannot read other hosts or projects.

```sh
python3 collector.py --url https://fusion.example.com --project PROJECT_ID --host j \
  --token-file /private/path/token --state /private/path/spool.sqlite
```

Keep this process running under the host's normal service manager. The collector checks native files modified in the last seven days, bounded to 2,000 files per scan. `--home` selects the native CLI user's home. It reads complete lines incrementally, keeps a private durable spool, resumes after outages and never resets an ambiguous replaced/truncated file automatically. Its own SQLite ledger is local transport state; canonical session and feedback storage is Fusion's PostgreSQL database.

Install feedback hooks independently of any other hook integrations:

```sh
python3 install_hooks.py --url https://fusion.example.com --project PROJECT_ID --host j \
  --token-file /private/path/token --state /private/path/spool.sqlite
# Review the target paths, then repeat with --apply.
```

The installer backs up existing settings. Route changes update matching plain Fusion commands for the same script, project, host, provider and spool, and remove duplicate owned invocations rather than appending another copy. Other hooks, shell wrappers and native trust decisions are preserved. Codex requires its hooks feature and native review/trust of the new command definitions. Restart/resume Claude sessions to load changed settings. Until a native hook actually registers a live runtime, Fusion displays feedback as unsupported.

M3's verified installation uses `http://<collector-endpoint>` directly over WireGuard; its collector and exactly five native commands per provider use that URL. The old loopback SSH tunnel LaunchAgent is stopped and disabled. Installer reruns must retain direct mode rather than bootstrap another tunnel. The dedicated J relay `fusion-wg-<collector>.service` binds only `<relay-bind-address>:4040`, allows only m3 source `<collector-source-address>`, and forwards to the unchanged loopback Fusion daemon. Preserve the separate existing `<legacy-relay-address>:4040` peer relay and public nginx authentication; do not expand allowlists or create public/all-interface bindings.

Network rollback is scoped: remove only the dedicated `fusion-wg-<collector>` unit, `<relay-config-path>` and its matching m3-only UFW rule on `wg-lan`; restore privately backed-up local collector/hook URLs and reenable the one saved tunnel if required. Stop the collector during rollback, validate the restored endpoint, then resume it. Preserve its durable spool, tokens, other hooks/native trust and all unrelated network services. Application/database rollback remains a separate consistent-snapshot procedure recorded in the delivery state.

Feedback is queued for five minutes and delivered as additional context at the next supported native hook. Resuming a session rotates its generation; old-generation feedback cannot enter the resumed runtime. Delivery acknowledges emitted native context, not proof that the agent acted on it. Ambiguous delivery is shown as uncertain and is never automatically replayed.

Open Fusion's **Agents → Remote agents**, select the configured project and a session. Collector connectivity and activity age are shown separately. Cost uses Fusion's recorded model/category pricing and shows its provenance. Claude's one-hour writes use its documented 2x input tariff, separately from five-minute writes. Unknown usage, models and unsupported fast/long-context pricing remain unavailable rather than becoming zero. Reported reasoning tokens are included in output tokens and are not charged twice. Partial known cost is labeled separately.

Agent launching/stopping/resuming, templates, notes/pins, transcript search, patches, AI summaries/watchers, rankings, notifications and historical AgentPulse migration are outside this implementation.

Run the native protocol tests with `python3 -m unittest discover -s scripts/remote-agents -p 'test_*.py'`. `pnpm smoke:external-sessions` exercises the real isolated Fusion HTTP ingest/read/pricing/feedback/restart flow without AgentPulse.
