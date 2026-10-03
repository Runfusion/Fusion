# External sessions vs Fusion task telemetry: the identity boundary

Measured: 2026-09-24, against the live Fusion PostgreSQL on J.

The integration plan's Phase 3 asks to "connect normalized external usage to Fusion analytics without
double-counting existing task telemetry", and constrains how: *"Link sessions to tasks explicitly or through
verified native identifiers; matching a project path or title alone is insufficient."*

**Verdict: the boundary is not provable today, so the connection was not built.** The two datasets do not
currently overlap, but nothing enforces that — they are disjoint by accident of directory layout, not by any
identifier, constraint or check.

## What exists

| Dataset | Rows on J | Identity it carries |
| --- | --- | --- |
| `project.tasks` with token usage | 869 of 1419 | `token_usage_*` columns, `worktree`, `branch`, `source_session_id` |
| `project.external_sessions` | 705 | `host_id`, `provider`, `native_session_id`, `observation->>'projectPath'` |
| `project.external_session_turns` | 357 | per-turn usage, since 2026-09-24 |

Token-bearing tasks by provider: `anthropic` 515 (2026-07-04 → 2026-07-19), `openai-codex` 354
(2026-07-08 → **2026-09-23**, ongoing). External sessions by provider: `codex` 638, `claude` 67. Both
datasets are therefore live at the same time, on overlapping providers.

## Why no link can be proven

- **No shared identifier.** `project.tasks` has no native-session column. The only structural bridge in the
  schema is `project.cli_sessions.native_session_id`, which is in the same identifier space as
  `external_sessions.native_session_id` — and `cli_sessions` holds **0 rows** on J.
- **`tasks.source_session_id` is populated on 0 rows**, so that is not a usable link either.
- **Nothing consults it anyway.** The external-session code never reads `cli_sessions`, and there is no
  deduplication or reconciliation logic in `packages/core/src/external-sessions/`.
- **Path matching is both forbidden and empty.** Exact worktree match: **0**. Prefix match
  (`projectPath LIKE worktree || '%'`): **0**. Every external session has a `projectPath`, so the comparison
  is meaningful rather than vacuous.

## Why they do not overlap today

Sessions by host: `m3` 637, `m5` 47, `j` 21.

All 637 m3 and 47 m5 sessions carry macOS operator paths (`/Users/v/dev/...`, `/Users/v/.codex/worktrees/...`).
Fusion's tasks run on J with worktrees under `/home/ubuntu/fusion-src/.fusion/worktrees/` and
`/srv/scrapeui-dev/.worktrees/`. Different machines: no possible double count.

All 21 J-host sessions carry server paths, so J does run both Fusion and a collector — but they sit in
different trees: `/home/ubuntu/.openclaw/workspace`, `/home/ubuntu/agentpulse-verification`,
`/home/ubuntu/fusion-deployments/...`, `/srv/scrapeui-rc`, versus Fusion's `.fusion/worktrees` and
`.worktrees` roots.

## The exact ambiguity

The disjointness above is a **property of the current directory layout, not an invariant**. If Fusion executes
an agent on a host whose collector also scrapes that provider's native transcripts — the same host, the same
provider, at the same time — the identical tokens land in `tasks.token_usage_*` and in
`external_session_turns.usage`. Summing them would double count, and:

- no identifier would reveal it, because none is shared;
- no constraint would prevent it;
- no test would fail, because nothing asserts the relationship;
- the only observable symptom would be a total that is quietly too large.

J is one directory move away from that state: it already runs Fusion and a collector on the same machine and
the same `openai-codex` provider.

## What would make it provable

Any one of these turns the boundary into something testable, at which point the connection can be built with a
regression that fails on double counting:

1. **Populate `cli_sessions.native_session_id`** for Fusion-run agents. This is the bridge the schema already
   anticipates: an external session whose `(provider, native_session_id)` matches a Fusion CLI session is the
   same underlying run, and its usage must be excluded from any combined total.
2. **Stamp the native session id onto the task** that owns the run, giving `tasks` a direct verified link.
3. **Record collector scope explicitly** — declare which paths on a host belong to Fusion-managed execution, so
   ingestion can refuse or tag transcripts from Fusion's own worktrees rather than relying on layout.

Until one of those exists, any combined figure would rest on an assumption about directory layout, which is
exactly the "project path alone" linkage the plan rules out.

## Resolved 2026-09-24: option 1, deterministic provider + native-id reconciliation (F4 = 1)

The operator chose bridge 1 above. `cli_sessions.native_session_id` is written back by the CLI telemetry hub
whenever a runtime reports it, and `ExternalSessionAttribution`
(`packages/core/src/external-sessions/attribution.ts`) resolves an external session to the Fusion task that
produced it by matching **(provider → adapter, native session id)**. The list and detail read surfaces carry the
result, so a session that IS a Fusion run is visibly already counted in that task's telemetry.

No backfill by path was performed, and none is possible: the path comparison measured **0** matches in both
directions, and the plan rules path matching out regardless. Sessions collected before the native id was written
back stay unattributed, which is the safe reading — unattributed never suppresses a cost.

Three refusals keep the match deterministic rather than plausible, each with a regression test in
`packages/core/src/__tests__/postgres/external-session-attribution.pg.test.ts`:

| Case | Answer | Why |
| --- | --- | --- |
| Native id still null (row created pre-spawn) | Not attributed | Null would otherwise match every unidentified session |
| Provider outside the mapping | Not attributed | `claude`/`codex` map to `claude-code`/`codex`; anything else is a guess |
| Two CLI sessions claim one native id | Ambiguous, no task named | A coin flip here mis-credits a real task's cost |
| Same session resolved repeatedly | Identical result, one entry | A re-import cannot accumulate |
| CLI session in another project | Not attributed | Scoped on `owner_project_id`, the domain project, as `CliSessionStore` is |

What is still NOT built: a single combined total that adds task telemetry and external usage together. The
attribution makes such a total *safe to build*; it does not itself produce one.
