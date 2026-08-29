# Plan: Mesh → Shared Postgres Multi-Node

**Date:** 2026-07-15
**Branch:** `feature/migrate-mesh`
**Status:** Implementation in progress (S1–S3 landed)

## Context

Fusion multi-node was built as multi-leader mesh over per-node SQLite. PostgreSQL cutover makes durable state shareable via one external `DATABASE_URL`. Mesh HTTP should own membership, optional auth material, and execution claims — not task/settings replication.

## Delivery slices

| Slice | Status | Outcome |
|---|---|---|
| S1 Docs + runbook | **Done** | multi-project, shared-mesh-protocol, architecture rewritten |
| S2 Dead-code removal | **Done** | remote task-id coordinator hop removed; settings mesh path retired on live routes |
| S3 Topology/auth-only queue | **Done** | PeerExchange enqueues/replays topology/auth only under backendMode |
| S4 Presence simplification | Deferred | optional PG heartbeats replacing gossip |
| S5 Claim e2e | Existing | PG claim tests in central-archive-secrets |
| S6 Auth/blob | Deferred | later |

## Non-goals

- Scheduler failover
- Live process migration
- Multi-leader task writes when Postgres is down

## Verification

- `peer-exchange-service.test.ts` (34)
- `mesh-routes.test.ts` (27)
- `shared-mesh-state.test.ts` (4)
