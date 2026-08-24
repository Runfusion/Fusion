---
category: test-failures
module: testing
problem_type: environment-provisioning
applies_when: Local PostgreSQL tests can reach TCP but schema setup or configured login fails.
tags: [postgresql, plpgsql, embedded-postgres, worktree, provisioning, fn-152]
---

# Repair a stale local PostgreSQL test server

A postmaster may remain alive after the worktree holding its embedded PostgreSQL payload is deleted. PostgreSQL derives `$libdir` from that executable, so `LANGUAGE plpgsql` then fails with `58P01` even though TCP accepts connections. The same cluster can also lack the role/database resolved by the test URL.

Use `pnpm pg:test:up` to stage the pinned payload in a durable home and verify configured login, PL/pgSQL, maintenance access, and admin DDL. The script derives role, password, and database using `postgres@3.4.9` URL/environment fallback rules; the database falls back to the role name. It only gates health checks whose independently resolved identities are guaranteed by provisioning. Bare and CI-shaped probes that resolve elsewhere are diagnostic notes, not blockers.

Do not tune `dynamic_library_path`, weaken `pgDescribe`, hardcode `postgres` plus the OS user, or gate success on a bare connection. A foreign server is never mutated. `--replace` requires a readable data directory, matching PID metadata, a live PostgreSQL process, and never-touch checks before a graceful stop; an identity-only foreign defect is refused with SQL for its operator instead.
