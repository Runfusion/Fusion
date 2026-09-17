# External session ingestion v1

This opt-in foundation records observations of independently started sessions. It has no UI,
provider collectors, transcripts, cost accounting, or control operations. Observations never
create Fusion tasks or acquire runtime authority. Titles and filesystem paths are display
metadata, not identity or permission. See [the PR sequence](external-sessions-pr-map.md).

## Test locally

From this source checkout, run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke:external-sessions
```

The smoke creates its own temporary home, project, embedded PostgreSQL database, random local HTTP
port, and random collector secret. Automation stays paused. It verifies health, authenticated
heartbeat, first ingestion, response-loss replay, sequence gaps/conflicts, a newer revision,
missing credentials, cross-project rejection, browser rejection, durable replay after restarting the owned server, and clean shutdown. Success prints
`PASS:` for each check and exits 0; all temporary state is removed. It never uses your running Fusion
instance or an ambient `DATABASE_URL`. No credential setup or live restart is needed.

This is a backend test; PR1 does not add a Sessions screen or discover Claude/AgentPulse sessions.
A terminal smoke demonstrates the contract. The UI and provider collectors follow in PR2/PR3.

For the focused automated regressions, provide a disposable PostgreSQL server with database-create
permission, then run:

```sh
FUSION_PG_TEST_URL_BASE=postgresql://postgres@127.0.0.1:55479 pnpm test:external-sessions
```

The harness creates and drops uniquely named databases on that server. CI runs these checks and the
HTTP smoke in the Gate job. A sandbox blocking PostgreSQL shared memory cannot run the database or
HTTP smoke; do not interpret skipped PostgreSQL cases as a successful acceptance check.

## Enable ingestion

Configure `FUSION_EXTERNAL_SESSION_COLLECTORS` as a JSON array of at most 128 credentials:

```json
[{"projectId":"registered-fusion-project-id","hostId":"stable-host-id","tokenSha256":"64-lowercase-hex-characters"}]
```

Each SHA-256 digest must identify exactly one host/project pair. Generate a random bearer secret
(at least 32 random bytes) using your secret manager; configure its digest on Fusion and keep the
secret only on the collector. Different projects on the same host use distinct credentials.
Server embedders can instead pass `ServerOptions.externalSessionCollectors`. Unset configuration
disables both endpoints (404); malformed/empty/ambiguous configuration fails closed (503).
Configuration is read at router construction; rotating credentials requires rebuilding the router
or restarting the instance. It is never returned by a settings/read endpoint.

The query `projectId` must be an existing registered project and match the credential exactly.
Host identity comes solely from that credential. Use TLS when sending requests over a network.
Collectors send only `Authorization: Bearer <secret>`; browser origins/fetch headers, cookies,
and query tokens do not authenticate ingestion. The same secret cannot access dashboard APIs.
Collector authentication remains mandatory under `--no-auth`.

## Observation delivery

`POST /api/external-sessions/ingest?projectId=<registered-project-id>`:

```json
{
  "schemaVersion": 1,
  "collectorVersion": "1.0.0",
  "streamId": "durable-spool-id",
  "sequence": 1,
  "eventId": "durable-event-id",
  "session": {
    "provider": "runtime-provider-id",
    "nativeSessionId": "native-session-id",
    "revision": 1,
    "activity": "working",
    "observedAt": "2026-09-17T00:00:00.000Z",
    "title": "Optional display title",
    "projectPath": "/optional/display/path"
  }
}
```

Supported activity values: `working`, `waiting`, `completed`, `failed`, `unknown`.
Identifiers are nonempty strings up to 256 characters with no control characters or surrounding
whitespace. Title is bounded to 512 characters and path to 4096; display metadata passes through
Fusion's secret redactor. Bodies are strict: unknown fields (including task links, capabilities,
host ids, and runtime handles) return 400. The global 100 KiB JSON parser and existing API/mutation
rate limits apply. No transcript/event-payload log is retained; only current metadata, digests,
and stream positions are durable.

A 200 response means the observation and delivery position committed:

```json
{"schemaVersion":1,"streamId":"durable-spool-id","acknowledgedSequence":1,"sessionId":"stable-sha256-id","applied":true}
```

Keep one durable spool identity across collector restarts; persist monotonically increasing
sequences starting at 1, together with the original event and body, before sending. Send serially
within each stream. At most 16 streams are allowed per host/project; stream ids are not process ids.
Never reset or recycle a stream's sequence. A replacement spool uses a new stream id, while native
session revisions still retain their high-water mark across all streams.

Retries at or below the acknowledged position are no-ops and return the current acknowledgement
with `applied:false`. The latest position retains a digest of the validated, redacted envelope: changing its retained body yields 409
`sequence-conflict`. Older positions retain only the high-water mark and cannot be reused to
change stored data; they are not individually fingerprint-verified. Event ids identify a position
inside the spool; they are not globally unique across streams. A delivery gap returns 409
`sequence-gap` with `acknowledgedSequence`; resend the next missing event. On `stream-limit`, reuse
an existing spool rather than silently discarding its position.

A session revision is a positive safe integer, monotonically increasing per native identity
across every spool/import for that session. Each revision is a complete snapshot, not a delta.
Higher revisions replace current metadata; lower revisions are acknowledged without applying.
Fingerprints are computed after display redaction; changing only removed secret bytes is equivalent to
the same retained snapshot, and raw secret hashes are never stored. A changed retained snapshot at the current revision returns 409 `revision-conflict` without advancing the
stream. Fix the collector's revision assignment; do not relabel conflicting content as a retry.
Provider/native ids are case-sensitive. Identity includes the credential's project and host;
renaming a title/path leaves identity unchanged. Changing provider/native id means a new session.
Keep host ids stable across restarts; a host id is not a hostname inferred from display paths.

After a timeout, 5xx, or 429, retain the spool entry and retry (honor `Retry-After` for 429).
Only a successful committed acknowledgement lets the sender remove all entries at or below that
position. `applied:false` can mean duplicate or older session revision, and still acknowledges
that position. A lost response after commit is safe to replay. Native transcript history is a
later contract extension, not an arbitrary JSON payload on this endpoint.

## Heartbeat

`POST /api/external-sessions/heartbeat?projectId=<registered-project-id>` with
`{"schemaVersion":1,"collectorVersion":"1.0.0"}` uses the same scoped credential. It records the
server receipt timestamp, not a caller-provided clock, and returns
`{"schemaVersion":1,"hostId":"stable-host-id"}` after durability succeeds. Replaying historical
observations never refreshes heartbeat. Collector connectivity and session activity are separate
signals; a connected collector can observe stale activity, and a completed session stays completed
when its collector disconnects.

## Preparation and rollback for a target server

These steps also apply to server J; paths, project ids, process manager, credentials, and database
connection must come from the operator's actual installation. PR1 needs no private host assumptions.
Nothing here authorizes a deployment or service restart.

1. Build the reviewed commit using `pnpm install --frozen-lockfile`, Fusion's workspace build,
   typecheck/lint, and gate. Preserve the exact built SHA and existing service configuration.
2. Before an authorized deployment, take a supported PostgreSQL backup and retain the currently
   deployed artifact. Verify the target's current schema ceiling and migration ledger. Migration
   0082 is additive and runs through Fusion startup; resolve upstream numbering collisions before
   deploying. Do not manually stamp the migration as applied. Startup probes all required external-session columns.
   Missing nullable receipt columns are repaired additively. Missing required identity, revision,
   fingerprint or acknowledgement data in populated tables fails startup transactionally; restore a
   supported backup instead of inventing state or resetting replay positions.
3. Deploy first with collector configuration absent. After authorization and a successful isolated
   smoke check, configure one registered test project/host credential. Verify heartbeat, one event,
   response-loss replay, and a gap conflict. Review durable counts before enabling real collectors.
4. Stop sending new observations by removing collector configuration and restarting/rebuilding the
   router when authorized. Retain external-session tables and stream positions; they are recovery
   state. Existing independent collector spools must keep their own acknowledgement positions.
5. Fusion rejects a binary older than the database schema ceiling. Reverting only the application
   after 0082 runs is insufficient: use the retained database backup with the matching old artifact
   in an isolated restore, or keep a compatible binary with ingestion disabled. Never delete ledger
   rows or tables to bypass this guard on a live database. Replaying acknowledged commands is not
   relevant to PR1 because it implements no command delivery.

Validation uses a disposable PostgreSQL cluster and the repository's existing isolated test harness.
Target-server deployment and rollback remain an operational verification step, separate from PR1.
