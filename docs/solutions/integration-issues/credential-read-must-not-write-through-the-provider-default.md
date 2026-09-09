---
title: "Credential reads must not write through the provider default"
date: 2026-09-09
category: integration-issues
module: engine-auth
problem_type: authentication_data_integrity
component: auth-storage
symptoms:
  - "Changing a default account replaces its saved OAuth material with another account"
  - "A running session continues using a previous default after an account switch"
resolution_type: code_fix
severity: high
tags: [oauth, credential-instances, auth-storage, anthropic, refresh]
related_components: [provider-auth, dashboard-auth-routes, model-runtime]
---

# Credential reads must not write through the provider default

## Defect family

FN-9285 and Runfusion/Fusion#3539 exposed the same unsafe pattern: code reads a credential through a bare provider id, then writes it back through that id. The write resolves the provider default again, so a pointer changed between the read and write can copy one account into another named row.

## Invariant

A credential read is side-effect free. When OAuth refresh returns new material, capture the concrete `ProviderInstanceRef` at read time and persist only to that row. Before writing, compare the row's secret material with the refresh candidate. If it changed, do not write; use the latest usable credential or retain the refresh result in memory.

## Freshness is separate from safety

File-backed storage revalidates its mtime and size before reads, allowing sessions that outlive a default-pointer change to pick up the new account. This is a freshness improvement, not the data-integrity guard: identity-fenced writes must remain safe even if a process has an old snapshot.

## Supplemental CLI hydration

Claude and Codex CLI credentials may hydrate a single bare Fusion row when no account identity can be proven. Hydration must refuse multi-instance providers, named targets, and stored/candidate rows with different `accountId` values. Opaque Anthropic tokens cannot reliably distinguish a rotated token from a different account, so the single-bare-row limit deliberately preserves established single-account synchronization.
