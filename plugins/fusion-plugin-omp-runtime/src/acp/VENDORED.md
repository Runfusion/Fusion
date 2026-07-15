# Vendored ACP client

**Source:** `plugins/fusion-plugin-acp-runtime/src/` (via `fusion-plugin-grok-runtime/src/acp/`)  
**Vendored:** 2026-07-11 for OMP ACP self-containment  

## Why

`fusion-plugin-omp-runtime` drives Oh My Pi (`omp`) over ACP (`omp acp`).  
`fusion-plugin-acp-runtime` is **experimental / on-demand**. Importing it at runtime
would couple OMP availability to the generic ACP plugin install path.

## What is copied

Client-side ACP only (JSON-RPC/stdio connect, session, event bridge, permission
floor, process registry, optional client fs). OMP-specific spawn/auth lives
outside this folder (`../acp-settings.ts`, `../runtime-adapter.ts`).

## Syncing

When fixing ACP client bugs in `fusion-plugin-acp-runtime` or the Grok vendor
copy, re-copy the client modules into this directory and note the date in FNXC
comments.
