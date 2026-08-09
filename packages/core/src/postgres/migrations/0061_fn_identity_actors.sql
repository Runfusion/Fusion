-- FNXC:Identity 2026-08-09-03:04:
-- U2 of the pluggable user identity plan (docs/plans/2026-08-07-001-feat-pluggable-user-identity-plan.md).
-- Additive only: introduces the actor registry, credentials, sessions, provider links, and
-- project-scoped role grants. Nothing existing is dropped or altered.
--
-- KTD7: actors/credentials/sessions/provider links live in `central` because one daemon serves N
-- projects from a shared Postgres and a solo developer needs ONE identity with different authority
-- per project; role grants therefore live in `project`.
-- KTD11: `project.project_auth_users/_memberships/_providers/_sessions` are deliberately left in
-- place. They have zero TypeScript readers but a live writer — the SQLite→Postgres cutover migrator
-- copies them by name-match and a missing target is a fail-closed startup error
-- (postgres/sqlite-migrator.ts → startup-factory.ts). The new names do not collide.
-- KTD17: `project.actor_role_grants.actor_id` is a PLAIN column, never a foreign key to
-- `central.actors`. No `central.*` table has RLS, every existing `REFERENCES central.*` is
-- central→central, and R4 requires a tombstoned actor to still resolve for audit display, so
-- ON DELETE CASCADE would be wrong. Referential integrity is enforced in core.
--
-- Every statement is re-runnable so an interrupted upgrade can replay this migration.

-- ── central.actors ───────────────────────────────────────────────────
-- FNXC:Identity 2026-08-09-03:04: `status` carries the R4 lifecycle. A tombstoned actor is retained
-- (never deleted) so historical audit rows keep resolving to a display name.
CREATE TABLE IF NOT EXISTS central.actors (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'provisioned'
    CHECK (status IN ('provisioned', 'active', 'suspended', 'tombstoned')),
  tombstoned_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actors_status ON central.actors (status);
CREATE INDEX IF NOT EXISTS idx_actors_kind ON central.actors (kind);

-- ── central.actor_credentials ────────────────────────────────────────
-- FNXC:Identity 2026-08-09-03:04: only a lookup id plus a hash of the secret is stored; the raw
-- credential value never lands in the database or in a backup dump.
CREATE TABLE IF NOT EXISTS central.actor_credentials (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES central.actors(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  lookup_id text NOT NULL,
  secret_hash text NOT NULL,
  kind text NOT NULL,
  expires_at text,
  revoked_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT actor_credentials_provider_lookup_unique UNIQUE (provider_id, lookup_id)
);
CREATE INDEX IF NOT EXISTS idx_actor_credentials_actor ON central.actor_credentials (actor_id);
CREATE INDEX IF NOT EXISTS idx_actor_credentials_active
  ON central.actor_credentials (provider_id, revoked_at);

-- ── central.actor_sessions ───────────────────────────────────────────
/*
FNXC:Identity 2026-08-09-03:04:
Sessions persist a lookup id plus an HMAC of the secret — NEVER the raw session value. The plan
accepts "a local shell user reaches Postgres directly" as a residual; storing live bearer tokens in
plaintext would upgrade that residual from *reads data* to *impersonates any administrator over
HTTP*, and the same holds for anyone holding a backup dump. R11's "opaque" guarantees
unguessability, not at-rest protection.
`kind` carries the human/agent split R29 needs: the two have different lifetime policies, so idle
and absolute expiry are evaluated per kind.
*/
CREATE TABLE IF NOT EXISTS central.actor_sessions (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES central.actors(id) ON DELETE CASCADE,
  lookup_id text NOT NULL,
  secret_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  issued_at text NOT NULL,
  idle_expires_at text,
  absolute_expires_at text NOT NULL,
  revoked_at text,
  provider_id text,
  CONSTRAINT actor_sessions_lookup_unique UNIQUE (lookup_id)
);
CREATE INDEX IF NOT EXISTS idx_actor_sessions_actor ON central.actor_sessions (actor_id);
CREATE INDEX IF NOT EXISTS idx_actor_sessions_absolute_expiry
  ON central.actor_sessions (absolute_expires_at);

-- ── central.actor_provider_links ─────────────────────────────────────
-- FNXC:Identity 2026-08-09-03:04: one external subject maps to at most one actor per provider, so a
-- second provider callback for the same subject can never mint a second actor.
CREATE TABLE IF NOT EXISTS central.actor_provider_links (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  external_subject_id text NOT NULL,
  actor_id text NOT NULL REFERENCES central.actors(id) ON DELETE CASCADE,
  linked_at text NOT NULL,
  CONSTRAINT actor_provider_links_provider_subject_unique UNIQUE (provider_id, external_subject_id)
);
CREATE INDEX IF NOT EXISTS idx_actor_provider_links_actor ON central.actor_provider_links (actor_id);

-- ── project.actor_role_grants ────────────────────────────────────────
DO $$
BEGIN
  /*
  FNXC:Identity 2026-08-09-03:04:
  PRIMARY KEY is (project_id, actor_id, role): the steady-state ownership audit in
  schema-applier.ts throws on EVERY subsequent boot unless every PK, unique constraint, and unique
  index on a `project` table includes project_id. RLS boilerplate mirrors
  0046_fn_8764_workflow_principal_fence.sql exactly — the policy and trigger names are load-bearing
  literals read by that same audit.
  */
  CREATE TABLE IF NOT EXISTS project.actor_role_grants (
    project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
    actor_id text NOT NULL,
    role text NOT NULL,
    granted_by_actor_id text,
    granted_at text NOT NULL,
    revoked_at text,
    PRIMARY KEY (project_id, actor_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_actor_role_grants_role
    ON project.actor_role_grants (project_id, role);
  CREATE INDEX IF NOT EXISTS idx_actor_role_grants_actor
    ON project.actor_role_grants (project_id, actor_id);
  ALTER TABLE project.actor_role_grants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE project.actor_role_grants FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS fusion_project_isolation ON project.actor_role_grants;
  CREATE POLICY fusion_project_isolation ON project.actor_role_grants
    USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
    WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
  DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.actor_role_grants;
  CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.actor_role_grants
    FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
END $$;
