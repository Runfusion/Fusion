/**
 * FNXC:Identity 2026-08-09-03:04:
 * U2 of the pluggable user identity plan: migration 0061 adds the actor registry, credentials,
 * sessions, and provider links to `central`, plus project-scoped role grants to `project`.
 *
 * What these tests exist to catch:
 *   - A migration registered in fewer than the four required sites in `applySchemaBaseline` never
 *     runs, and every other test still passes. Only asserting the tables EXIST on a real database
 *     detects that.
 *   - A `project` table whose PK omits `project_id` makes the steady-state ownership audit throw on
 *     every SUBSEQUENT boot — never the first. Only a second `applySchemaBaseline` catches it.
 *   - Storing a raw session value would upgrade the accepted "local shell user reaches Postgres"
 *     residual to "impersonates any administrator over HTTP" (and the same for a backup dump).
 *   - KTD11: `project_auth_*` looks dead but has a live writer (the SQLite→Postgres cutover
 *     migrator); a missing target there is a fail-closed startup error, so it must survive 0061.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../__test-utils__/pg-test-harness.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  IDENTITY_ACTORS_VERSION,
  SCHEMA_BASELINE_VERSION,
} from "../postgres/schema-applier.js";
import { createConnectionSetFromUrl } from "../postgres/connection.js";
import { createAsyncDataLayer } from "../postgres/data-layer.js";
import { grantActorRole, revokeActorRole, suspendActor } from "../identity/actor-store.js";
import type { ResolvedBackend } from "../postgres/backend-resolver.js";

const NOW = "2026-08-09T03:04:00.000Z";

describe("identity schema: migration identity", () => {
  /*
  FNXC:Identity 2026-08-15-22:52:
  Renumbered 0047 -> 0059 -> 0060 -> 0061 because main already shipped 0060 as workspace
  coordination leases. Two migrations sharing one bookkeeping identity would skip identity tables
  on upgraded databases.
  */
  it("assigns the identity schema its own immutable migration version at the current ceiling", () => {
    expect(IDENTITY_ACTORS_VERSION).toBe("0067");
    expect(SCHEMA_BASELINE_VERSION).toBe("0067");
  });
});

pgDescribe("identity schema: migration 0061", () => {
  async function withHarness(fn: (h: PgTestHarness) => Promise<void>): Promise<void> {
    const h = await createTaskStoreForTest({ prefix: "fusion_identity" });
    try {
      await fn(h);
    } finally {
      await h.teardown();
    }
  }

  /** The NOSUPERUSER role production runs as; a superuser bypasses every privilege check here. */
  async function ensureRuntimeRole(h: PgTestHarness): Promise<void> {
    await h.adminSql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
          CREATE ROLE fusion_runtime NOLOGIN NOSUPERUSER;
        END IF;
        EXECUTE format('GRANT fusion_runtime TO %I', current_user);
      END $$
    `);
  }

  async function runtimeRoleConnections(h: PgTestHarness, projectId: string) {
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: h.testUrl,
      migrationUrl: h.testUrl,
      migrationUrlOverridden: false,
    };
    return createConnectionSetFromUrl(backend, {
      poolMax: 1,
      connectTimeoutSeconds: 5,
      projectId,
      useRuntimeRole: true,
    });
  }

  async function seedActor(h: PgTestHarness, id: string, kind = "human"): Promise<void> {
    await h.adminSql`
      INSERT INTO central.actors (id, kind, display_name, status, created_at, updated_at)
      VALUES (${id}, ${kind}, ${`Actor ${id}`}, 'active', ${NOW}, ${NOW})
    `;
  }

  it("applies on a fresh database and creates every identity table", async () => {
    await withHarness(async (h) => {
      const rows = (await h.adminSql`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE (table_schema = 'central' AND table_name IN ('actors', 'actor_credentials', 'actor_sessions', 'actor_provider_links'))
           OR (table_schema = 'project' AND table_name = 'actor_role_grants')
        ORDER BY table_schema, table_name
      `) as unknown as Array<{ table_schema: string; table_name: string }>;
      expect(rows.map((r) => `${r.table_schema}.${r.table_name}`)).toEqual([
        "central.actor_credentials",
        "central.actor_provider_links",
        "central.actor_sessions",
        "central.actors",
        "project.actor_role_grants",
      ]);

      const applied = await getAppliedMigrations(h.adminDb);
      expect(applied).toContain(IDENTITY_ACTORS_VERSION);
    });
  });

  it("gives each identity table the columns the actor model needs", async () => {
    await withHarness(async (h) => {
      const columnsOf = async (schema: string, table: string): Promise<string[]> => {
        const rows = (await h.adminSql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = ${table}
          ORDER BY column_name
        `) as unknown as Array<{ column_name: string }>;
        return rows.map((r) => r.column_name);
      };

      expect(await columnsOf("central", "actors")).toEqual([
        "created_at", "display_name", "id", "kind", "status", "tombstoned_at", "updated_at",
      ]);
      expect(await columnsOf("central", "actor_credentials")).toEqual([
        "actor_id", "created_at", "expires_at", "id", "kind", "lookup_id", "provider_id",
        "revoked_at", "secret_hash", "updated_at",
      ]);
      expect(await columnsOf("central", "actor_sessions")).toEqual([
        "absolute_expires_at", "actor_id", "id", "idle_expires_at", "issued_at", "kind",
        "lookup_id", "provider_id", "revoked_at", "secret_hash",
      ]);
      expect(await columnsOf("central", "actor_provider_links")).toEqual([
        "actor_id", "external_subject_id", "id", "linked_at", "provider_id",
      ]);
      expect(await columnsOf("project", "actor_role_grants")).toEqual([
        "actor_id", "granted_at", "granted_by_actor_id", "project_id", "revoked_at", "role",
      ]);
    });
  });

  /*
  FNXC:Identity 2026-08-09-03:04:
  The second boot is the load-bearing one: `applySchemaBaseline` only runs the steady-state
  ownership audit when the ownership migration is ALREADY recorded, so a project table whose PK
  omitted project_id would pass its first application and throw on every boot afterwards.
  */
  it("re-applies as a no-op and passes the steady-state ownership audit on a second boot", async () => {
    await withHarness(async (h) => {
      await expect(applySchemaBaseline(h.adminDb, { pluginHooks: [] })).resolves.toMatchObject({
        applied: false,
      });
      await expect(applySchemaBaseline(h.adminDb, { pluginHooks: [] })).resolves.toMatchObject({
        applied: false,
      });
    });
  });

  it("keys actor_role_grants on (project_id, actor_id, role) with RLS enabled and forced", async () => {
    await withHarness(async (h) => {
      const pk = (await h.adminSql`
        SELECT a.attname AS column_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE n.nspname = 'project' AND t.relname = 'actor_role_grants' AND c.contype = 'p'
        ORDER BY k.ord
      `) as unknown as Array<{ column_name: string }>;
      expect(pk.map((r) => r.column_name)).toEqual(["project_id", "actor_id", "role"]);

      const rls = (await h.adminSql`
        SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'fusion_project_isolation') AS policies,
               (SELECT count(*)::int FROM pg_trigger g
                 WHERE g.tgrelid = c.oid AND g.tgname = 'fusion_assign_project_id') AS triggers
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'project' AND c.relname = 'actor_role_grants'
      `) as unknown as Array<{ enabled: boolean; forced: boolean; policies: number; triggers: number }>;
      expect(rls[0]).toEqual({ enabled: true, forced: true, policies: 1, triggers: 1 });
    });
  });

  /*
  FNXC:Identity 2026-08-09-03:04:
  KTD17 leaves no database-layer guard against a session leaking across projects, so the RLS policy
  on grants is what actually contains authority per project. Exercise it through the NOSUPERUSER
  `fusion_runtime` role, because a superuser bypasses RLS and would make this test vacuous.
  */
  it("isolates actor_role_grants between projects under the forced-RLS runtime role", async () => {
    await withHarness(async (h) => {
      await h.adminSql.unsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
            CREATE ROLE fusion_runtime NOLOGIN NOSUPERUSER;
          END IF;
          EXECUTE format('GRANT fusion_runtime TO %I', current_user);
        END $$
      `);
      await seedActor(h, "actor-a");
      await seedActor(h, "actor-b");

      const backend: ResolvedBackend = {
        mode: "external",
        runtimeUrl: h.testUrl,
        migrationUrl: h.testUrl,
        migrationUrlOverridden: false,
      };
      const projectA = await createConnectionSetFromUrl(backend, {
        poolMax: 1,
        connectTimeoutSeconds: 5,
        projectId: "project-a",
        useRuntimeRole: true,
      });
      const projectB = await createConnectionSetFromUrl(backend, {
        poolMax: 1,
        connectTimeoutSeconds: 5,
        projectId: "project-b",
        useRuntimeRole: true,
      });
      try {
        /*
        FNXC:IdentityGrantEscalation 2026-08-09-03:04:
        Seeded over the OWNER connection, not the runtime role, because 0059 revokes write on this
        table from `fusion_runtime` (that revoke is what stops a plugin granting itself a role). The
        runtime role keeps SELECT, which is the half this test is about: it asserts that RLS filters
        what each project can READ. project_id is explicit here — the owner connection runs with
        `fusion.project_bypass = on`, so the fusion_assign_project_id trigger cannot infer it.
        */
        await h.adminSql`
          INSERT INTO project.actor_role_grants (project_id, actor_id, role, granted_at)
          VALUES ('project-a', 'actor-a', 'admin', ${NOW}), ('project-b', 'actor-b', 'viewer', ${NOW})
        `;

        const seenByA = (await projectA.runtime.execute(sql`
          SELECT project_id, actor_id, role FROM project.actor_role_grants ORDER BY actor_id
        `)) as unknown as Array<{ project_id: string; actor_id: string; role: string }>;
        expect(seenByA).toEqual([{ project_id: "project-a", actor_id: "actor-a", role: "admin" }]);

        const seenByB = (await projectB.runtime.execute(sql`
          SELECT project_id, actor_id, role FROM project.actor_role_grants ORDER BY actor_id
        `)) as unknown as Array<{ project_id: string; actor_id: string; role: string }>;
        expect(seenByB).toEqual([{ project_id: "project-b", actor_id: "actor-b", role: "viewer" }]);

        // Both rows really are on disk — project A's read was filtered, not empty.
        const all = (await h.adminSql`
          SELECT project_id FROM project.actor_role_grants ORDER BY project_id
        `) as unknown as Array<{ project_id: string }>;
        expect(all.map((r) => r.project_id)).toEqual(["project-a", "project-b"]);
      } finally {
        await projectA.close();
        await projectB.close();
      }
    });
  });

  /*
  FNXC:IdentityGrantEscalation 2026-08-09-03:04:
  AE18 / U5 step 4. A plugin holds the same pooled `fusion_runtime` connection core does (the plugin
  gate does not deny `getAsyncLayer()`), and RLS on this table filters by project_id, never by caller
  — so before 0059's REVOKE, a plugin could INSERT itself an `admin` grant and every downstream
  `can()` check would then honestly allow it. Asserted at the ROLE boundary rather than through a
  plugin fixture: that is where the guarantee actually lives, and it holds for any caller who gets a
  raw handle, including ones no fixture anticipates.

  Both verbs are asserted. The write must be rejected and the read must still succeed: revoking SELECT
  too would "pass" a denial test while breaking enforcement, since authorization reads grants on this
  same runtime connection on every mutation.
  */
  /*
  FNXC:IdentityGrantEscalation 2026-08-09-03:04:
  Assert the rejection by PostgreSQL's `42501 insufficient_privilege` code, walking the cause chain.
  Two reasons this is not a message match: drizzle wraps the driver error, so the outer message is
  only "Failed query: ..." and the real text lives on `cause`; and a bare `.rejects.toThrow()` would
  pass on ANY failure — an RLS violation, a typo'd column, a dropped table — which is precisely how a
  privilege test comes to assert nothing. The code pins the exact reason we require.
  */
  async function expectInsufficientPrivilege(operation: Promise<unknown>): Promise<void> {
    let thrown: unknown;
    try {
      await operation;
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "expected the statement to be rejected, but it succeeded").toBeDefined();
    const codes: unknown[] = [];
    for (let cursor = thrown, depth = 0; cursor !== undefined && cursor !== null && depth < 8; depth++) {
      codes.push((cursor as { code?: unknown }).code);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    expect(codes, `expected 42501 in the cause chain, saw codes: ${JSON.stringify(codes)}`).toContain("42501");
  }

  it("denies the runtime role write on actor_role_grants while preserving its reads", async () => {
    await withHarness(async (h) => {
      await h.adminSql.unsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
            CREATE ROLE fusion_runtime NOLOGIN NOSUPERUSER;
          END IF;
          EXECUTE format('GRANT fusion_runtime TO %I', current_user);
        END $$
      `);
      await seedActor(h, "actor-a");
      await h.adminSql`
        INSERT INTO project.actor_role_grants (project_id, actor_id, role, granted_at)
        VALUES ('project-a', 'actor-a', 'viewer', ${NOW})
      `;

      const backend: ResolvedBackend = {
        mode: "external",
        runtimeUrl: h.testUrl,
        migrationUrl: h.testUrl,
        migrationUrlOverridden: false,
      };
      const projectA = await createConnectionSetFromUrl(backend, {
        poolMax: 1,
        connectTimeoutSeconds: 5,
        projectId: "project-a",
        useRuntimeRole: true,
      });
      try {
        /*
        FNXC:IdentityGrantEscalation 2026-08-09-03:04:
        Pin the session identity before asserting any denial. `FORCE ROW LEVEL SECURITY` applies to
        the table owner too, so a passing RLS assertion does NOT prove the connection actually
        switched to `fusion_runtime` — without this, every denial below could be asserting against
        the wrong role, or against a role holding no privilege on the table for unrelated reasons,
        and would pass either way.
        */
        const identity = (await projectA.runtime.execute(sql`
          SELECT current_user::text AS current_user_name,
                 has_table_privilege('project.actor_role_grants', 'INSERT') AS can_insert,
                 has_table_privilege('project.actor_role_grants', 'SELECT') AS can_select
        `)) as unknown as Array<{ current_user_name: string; can_insert: boolean; can_select: boolean }>;
        expect(identity[0]).toEqual({
          current_user_name: "fusion_runtime",
          can_insert: false,
          can_select: true,
        });

        // The escalation itself: grant myself admin in my own project. Must be refused.
        await expectInsufficientPrivilege(
          projectA.runtime.execute(sql`
            INSERT INTO project.actor_role_grants (actor_id, role, granted_at)
            VALUES ('actor-a', 'admin', ${NOW})
          `),
        );

        // Escalation by mutating the row that already exists is the same attack; also refused.
        await expectInsufficientPrivilege(
          projectA.runtime.execute(sql`
            UPDATE project.actor_role_grants SET role = 'admin' WHERE actor_id = 'actor-a'
          `),
        );

        // Revoking the grant that constrains you is an escalation too.
        await expectInsufficientPrivilege(
          projectA.runtime.execute(sql`DELETE FROM project.actor_role_grants WHERE actor_id = 'actor-a'`),
        );

        // Reads must survive — enforcement depends on them, and no write above took effect.
        const seen = (await projectA.runtime.execute(sql`
          SELECT actor_id, role FROM project.actor_role_grants
        `)) as unknown as Array<{ actor_id: string; role: string }>;
        expect(seen).toEqual([{ actor_id: "actor-a", role: "viewer" }]);
      } finally {
        await projectA.close();
      }
    });
  });

  /*
  FNXC:IdentityGrantEscalation 2026-08-09-03:04:
  0059's REVOKE closed the plugin escalation but also sat on every LEGITIMATE grant write, which all
  went over `layer.db` — the runtime role that just lost the privilege. That regression was invisible
  to the actor-store suite because it builds its layer on the harness's OWNER connection, so those
  writes never exercised the affected role. These tests run through a layer whose `db` really is
  `fusion_runtime`, which is the only configuration that can catch it.
  */
  it("writes a role grant through the privileged handle when db is the runtime role", async () => {
    await withHarness(async (h) => {
      await ensureRuntimeRole(h);
      await seedActor(h, "grantee");
      const connections = await runtimeRoleConnections(h, "project-a");
      try {
        const layer = createAsyncDataLayer(connections, { projectId: "project-a" });

        // Proves the privileged handle is doing the work: the identical write over the runtime
        // handle is refused, so a regression back to `layer.db` cannot pass this test.
        await expectInsufficientPrivilege(
          grantActorRole({ ...layer, privilegedDb: undefined }, { actorId: "grantee", role: "merger" }),
        );

        await grantActorRole(layer, { actorId: "grantee", role: "merger" });
        const rows = (await h.adminSql`
          SELECT project_id, actor_id, role FROM project.actor_role_grants
        `) as unknown as Array<{ project_id: string; actor_id: string; role: string }>;
        expect(rows).toEqual([{ project_id: "project-a", actor_id: "grantee", role: "merger" }]);
      } finally {
        await connections.close();
      }
    });
  });

  /*
  The owner connection bypasses project isolation, so RLS no longer confines this statement. Without
  the explicit project predicate, revoking one project's role revokes it in every project — a
  single-project admin action going global with no error at the call site.
  */
  it("revokes a role only in the bound project, not in every project", async () => {
    await withHarness(async (h) => {
      await ensureRuntimeRole(h);
      await seedActor(h, "shared");
      await h.adminSql`
        INSERT INTO project.actor_role_grants (project_id, actor_id, role, granted_at)
        VALUES ('project-a', 'shared', 'merger', ${NOW}), ('project-b', 'shared', 'merger', ${NOW})
      `;
      const connections = await runtimeRoleConnections(h, "project-a");
      try {
        await revokeActorRole(
          createAsyncDataLayer(connections, { projectId: "project-a" }),
          "shared",
          "merger",
          NOW,
        );
        const rows = (await h.adminSql`
          SELECT project_id, revoked_at FROM project.actor_role_grants ORDER BY project_id
        `) as unknown as Array<{ project_id: string; revoked_at: string | null }>;
        expect(rows).toEqual([
          { project_id: "project-a", revoked_at: NOW },
          { project_id: "project-b", revoked_at: null },
        ]);
      } finally {
        await connections.close();
      }
    });
  });

  /*
  Suspension is documented to drop an actor's authority in EVERY project (actors are global, grants
  are per-project). Running the whole transaction on the owner connection is what makes that true —
  under RLS on a project-bound runtime connection it only ever reached the bound project.
  */
  it("drops an actor's grants in every project when the actor is suspended", async () => {
    await withHarness(async (h) => {
      await ensureRuntimeRole(h);
      await seedActor(h, "everywhere");
      await h.adminSql`
        INSERT INTO project.actor_role_grants (project_id, actor_id, role, granted_at)
        VALUES ('project-a', 'everywhere', 'merger', ${NOW}), ('project-b', 'everywhere', 'merger', ${NOW})
      `;
      const connections = await runtimeRoleConnections(h, "project-a");
      try {
        await suspendActor(
          createAsyncDataLayer(connections, { projectId: "project-a" }),
          "everywhere",
          NOW,
        );
        const live = (await h.adminSql`
          SELECT project_id FROM project.actor_role_grants WHERE revoked_at IS NULL
        `) as unknown as Array<{ project_id: string }>;
        expect(live).toEqual([]);
      } finally {
        await connections.close();
      }
    });
  });

  it("rejects a duplicate (provider_id, external_subject_id) provider link", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "actor-a");
      await seedActor(h, "actor-b");
      await h.adminSql`
        INSERT INTO central.actor_provider_links (id, provider_id, external_subject_id, actor_id, linked_at)
        VALUES ('link-1', 'local', 'subject-1', 'actor-a', ${NOW})
      `;
      await expect(h.adminSql`
        INSERT INTO central.actor_provider_links (id, provider_id, external_subject_id, actor_id, linked_at)
        VALUES ('link-2', 'local', 'subject-1', 'actor-b', ${NOW})
      `).rejects.toThrow(/actor_provider_links_provider_subject_unique|duplicate key/i);

      // A different provider may legitimately carry the same external subject id.
      await h.adminSql`
        INSERT INTO central.actor_provider_links (id, provider_id, external_subject_id, actor_id, linked_at)
        VALUES ('link-3', 'oidc', 'subject-1', 'actor-b', ${NOW})
      `;
      const rows = (await h.adminSql`
        SELECT count(*)::int AS n FROM central.actor_provider_links
      `) as unknown as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(2);
    });
  });

  it("never stores the raw session value — only a lookup id and a hash", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "actor-a");
      const rawSessionValue = "fusion_sess_raw_do_not_persist_9f3c";
      const lookupId = "lookup-9f3c";
      // The hash is computed by the caller (U2 stores it; the KTD4 token module mints it later).
      const secretHash = createHmac("sha256", "test-pepper").update(rawSessionValue).digest("hex");
      await h.adminSql`
        INSERT INTO central.actor_sessions (
          id, actor_id, lookup_id, secret_hash, kind, issued_at, idle_expires_at,
          absolute_expires_at, provider_id
        ) VALUES (
          'session-1', 'actor-a', ${lookupId}, ${secretHash},
          'human', ${NOW}, ${NOW}, ${NOW}, 'local'
        )
      `;

      const rows = (await h.adminSql`
        SELECT to_jsonb(s) AS row FROM central.actor_sessions s
      `) as unknown as Array<{ row: Record<string, unknown> }>;
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]?.row);
      expect(serialized).not.toContain(rawSessionValue);
      expect(serialized).toContain(lookupId);
      expect(String(rows[0]?.row.secret_hash ?? "")).not.toBe(rawSessionValue);
      expect(String(rows[0]?.row.secret_hash ?? "").length).toBeGreaterThan(0);
    });
  });

  /*
  FNXC:Identity 2026-08-09-03:04:
  KTD11 — the `project_auth_*` tables have zero TypeScript readers but a live writer in the
  SQLite→Postgres cutover migrator, where a missing target is a fail-closed startup error. 0061 is
  additive precisely so upgrades from a legacy SQLite database are not bricked.
  */
  it("leaves the legacy project_auth_* preservation tables untouched", async () => {
    await withHarness(async (h) => {
      const rows = (await h.adminSql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'project' AND table_name LIKE 'project_auth_%'
        ORDER BY table_name
      `) as unknown as Array<{ table_name: string }>;
      expect(rows.map((r) => r.table_name)).toEqual([
        "project_auth_memberships",
        "project_auth_providers",
        "project_auth_sessions",
        "project_auth_users",
      ]);
    });
  });
});
