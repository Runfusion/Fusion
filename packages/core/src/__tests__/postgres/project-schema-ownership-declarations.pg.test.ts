import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { AsyncSecretsStore } from "../../async-stores/async-secrets-store.js";
import { createApprovalRequest } from "../../async-stores/async-approval-request-store.js";
import { addChatMessage } from "../../async-stores/async-chat-store.js";
import { recordRunAuditEvent, recordRunAuditEventWithinTransaction } from "../../postgres/data-layer.js";
import { insertArtifactRow } from "../../task-store/async/async-comments-attachments.js";
import { createBranchGroup } from "../../task-store/async/async-branch-groups.js";
import { recordPluginActivation } from "../../task-store/async/async-events.js";
import * as schema from "../../postgres/schema/index.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const tableNames = [
  "artifacts",
  "secrets",
  "branch_groups",
  "plugin_activations",
  "chat_messages",
  "run_audit_events",
  "verification_cache",
  "approval_requests",
] as const;

const declaredTables = {
  artifacts: schema.project.artifacts,
  secrets: schema.project.secrets,
  branch_groups: schema.project.branchGroups,
  plugin_activations: schema.project.pluginActivations,
  chat_messages: schema.project.chatMessages,
  run_audit_events: schema.project.runAuditEvents,
  verification_cache: schema.project.verificationCache,
  approval_requests: schema.project.approvalRequests,
} as const;

const expectedPrimaryKeys: Record<(typeof tableNames)[number], string[]> = {
  artifacts: ["project_id", "id"],
  secrets: ["project_id", "id"],
  branch_groups: ["project_id", "id"],
  plugin_activations: ["project_id", "id"],
  chat_messages: ["project_id", "id"],
  run_audit_events: ["project_id", "id"],
  verification_cache: ["project_id", "tree_sha", "test_command", "build_command"],
  approval_requests: ["project_id", "id"],
};

pgDescribe("project schema ownership declarations", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_fn9002_schema",
    projectId: "fn9002-runtime-bound",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("proves migration 0006 physically partitions all eight drifted tables", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-08-12-13:45:
    Migration 0006 partitioned every project-schema base table before these eight Drizzle
    declarations caught up. Assert catalog truth first so declaration work cannot guess an
    ordered key, unique index, or foreign-key name from the pre-isolation snapshot.
    */
    for (const tableName of tableNames) {
      const columns = await h.adminSql()<Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>>`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'project' AND table_name = ${tableName} AND column_name = 'project_id'
      `;
      expect(columns).toEqual([expect.objectContaining({
        column_name: "project_id",
        data_type: "text",
        is_nullable: "NO",
        column_default: expect.stringContaining("current_setting"),
      })]);

      const constraints = await h.adminSql()<Array<{
        conname: string;
        contype: string;
        columns: string[];
      }>>`
        SELECT c.conname, c.contype, array_agg(a.attname ORDER BY k.ordinality) AS columns
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = ('project.' || ${tableName})::regclass
          AND c.contype IN ('p', 'u', 'f')
        GROUP BY c.conname, c.contype
        ORDER BY c.contype, c.conname
      `;
      expect(constraints.find((constraint) => constraint.contype === "p")?.columns)
        .toEqual(expectedPrimaryKeys[tableName]);
      for (const constraint of constraints) {
        expect(constraint.columns[0]).toBe("project_id");
      }

      const uniqueIndexes = await h.adminSql()<Array<{ index_name: string; columns: string[] }>>`
        SELECT idx.relname AS index_name,
          array_agg(a.attname ORDER BY key.ordinality) AS columns
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
        WHERE i.indrelid = ('project.' || ${tableName})::regclass
          AND i.indisunique AND NOT i.indisprimary
        GROUP BY idx.relname
      `;
      for (const index of uniqueIndexes) {
        expect(index.columns[0]).toBe("project_id");
      }

      const declaration = getTableConfig(declaredTables[tableName]);
      expect(declaration.columns.map((column) => column.name)).toContain("project_id");
      expect(declaration.columns.find((column) => column.name === "project_id")?.hasDefault).toBe(true);
      expect(declaration.primaryKeys).toHaveLength(1);
      expect(declaration.primaryKeys[0]?.columns.map((column) => column.name))
        .toEqual(expectedPrimaryKeys[tableName]);
    }

    const artifactForeignKey = getTableConfig(schema.project.artifacts).foreignKeys
      .find((key) => key.getName() === "artifacts_task_id_fkey");
    expect(artifactForeignKey?.reference().columns.map((column) => column.name))
      .toEqual(["project_id", "task_id"]);
    expect(artifactForeignKey?.reference().foreignColumns.map((column) => column.name))
      .toEqual(["project_id", "id"]);
    expect(getTableConfig(schema.project.secrets).uniqueConstraints.map((key) => ({
      name: key.getName(), columns: key.columns.map((column) => column.name),
    }))).toContainEqual({ name: "secrets_key_unique", columns: ["project_id", "key"] });
    expect(getTableConfig(schema.project.branchGroups).uniqueConstraints.map((key) => ({
      name: key.getName(), columns: key.columns.map((column) => column.name),
    }))).toContainEqual({ name: "branch_groups_branch_name_key", columns: ["project_id", "branch_name"] });
  });

  it("keeps production inserts default-stamped and public mappers partition-free", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-08-12-13:45:
    These are the real async store helpers whose inserts intentionally omit projectId. Exercise
    them through a GUC-bound layer so the declaration change proves Drizzle still delegates
    ownership stamping to migration 0006 rather than relying only on catalog or raw-SQL tests.
    */
    const layer = h.layer();
    const artifact = await insertArtifactRow(layer, {
      type: "document", title: "Runtime artifact", content: "content", authorId: "agent",
      authorType: "agent",
    }, {});
    const secrets = new AsyncSecretsStore(layer, async () => Buffer.alloc(32, 7));
    const secret = await secrets.createSecret({ scope: "project", key: "RUNTIME_KEY", plaintextValue: "value" });
    const branchGroup = await createBranchGroup(layer.db, {
      sourceType: "planning", sourceId: "runtime", branchName: "runtime-branch",
    });
    const activation = await recordPluginActivation(layer.db, { pluginId: "runtime-plugin", source: "test" });
    const message = await addChatMessage(layer.db, {
      id: "runtime-message", sessionId: "runtime-session", role: "user", content: "Runtime",
      thinkingOutput: null, metadata: null, attachments: undefined, createdAt: "2026-08-12T00:00:00.000Z",
    });
    const audit = await recordRunAuditEvent(layer, {
      agentId: "agent", runId: "runtime-run", domain: "test", mutationType: "insert", target: "runtime",
    });
    const approval = await createApprovalRequest(layer, {
      id: "runtime-approval",
      requester: { actorId: "agent", actorType: "agent", actorName: "Agent" },
      targetAction: { category: "test", action: "insert", summary: "Runtime", resourceType: "task", resourceId: "runtime" },
    });
    await h.store().recordVerificationCachePass("runtime-tree", "test", "build", "runtime-task");
    await h.store().recordVerificationCachePass("runtime-tree", "test", "build", "updated-task");

    const mapped = [artifact, secret, branchGroup, activation, message, audit, approval];
    for (const row of mapped) expect("projectId" in row).toBe(false);
    expect(await h.store().getVerificationCacheHit("runtime-tree", "test", "build"))
      .toMatchObject({ taskId: "updated-task" });

    for (const tableName of tableNames) {
      const rows = await h.adminSql()<Array<{ project_id: string }>>`
        SELECT project_id FROM project.${h.adminSql().unsafe(tableName)}
        WHERE project_id = 'fn9002-runtime-bound'
      `;
      expect(rows.length).toBeGreaterThan(0);
    }

    await layer.transactionImmediate(async (tx) => {
      await tx.execute(sql`SELECT set_config('fusion.project_id', '', true)`);
      await recordRunAuditEventWithinTransaction(tx, {
        agentId: "agent", runId: "unbound-run", domain: "test", mutationType: "insert", target: "unbound",
      });
    });
    expect(await h.adminSql()<Array<{ project_id: string }>>`
      SELECT project_id FROM project.run_audit_events WHERE run_id = 'unbound-run'
    `).toEqual([{ project_id: "__legacy_unscoped__" }]);
  });

  it("keeps duplicate natural identities available in every physical partition", async () => {
    const insertRows = async (projectId: string): Promise<void> => {
      await h.adminSql()`SELECT set_config('fusion.project_id', ${projectId}, false)`;
      await h.adminSql()`INSERT INTO project.artifacts (id, type, title, author_id, created_at, updated_at)
        VALUES ('shared', 'document', 'Shared', 'agent', '2026-08-12', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.secrets (id, key, value_ciphertext, nonce, created_at, updated_at)
        VALUES ('shared', 'SHARED_KEY', decode('00', 'hex'), decode('00', 'hex'), '2026-08-12', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.branch_groups (id, source_type, source_id, branch_name, created_at, updated_at)
        VALUES ('shared', 'planning', 'shared', 'shared-branch', 1, 1)`;
      await h.adminSql()`INSERT INTO project.plugin_activations (plugin_id, source, activated_at)
        VALUES ('shared', 'test', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.chat_messages (id, session_id, role, content, created_at)
        VALUES ('shared', 'shared', 'user', 'Shared', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.run_audit_events (id, timestamp, agent_id, run_id, domain, mutation_type, target)
        VALUES ('shared', '2026-08-12', 'agent', 'run', 'test', 'insert', 'shared')`;
      await h.adminSql()`INSERT INTO project.verification_cache (tree_sha, test_command, build_command, recorded_at)
        VALUES ('shared', 'test', 'build', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.approval_requests (
        id, status, requester_actor_id, requester_actor_type, requester_actor_name,
        target_action_category, target_action_operation, target_action_summary,
        target_resource_type, target_resource_id, requested_at, created_at, updated_at
      ) VALUES (
        'shared', 'pending', 'agent', 'agent', 'Agent', 'test', 'insert', 'Shared',
        'task', 'shared', '2026-08-12', '2026-08-12', '2026-08-12'
      )`;
    };

    await insertRows("fn9002-project-a");
    await insertRows("fn9002-project-b");
    for (const tableName of tableNames) {
      const rows = await h.adminSql()<Array<{ count: string }>>`
        SELECT count(*)::text AS count FROM project.${h.adminSql().unsafe(tableName)}
        WHERE project_id IN ('fn9002-project-a', 'fn9002-project-b')
      `;
      expect(rows).toEqual([{ count: "2" }]);
    }

    await h.adminSql()`SELECT set_config('fusion.project_id', '', false)`;
    await h.adminSql()`INSERT INTO project.chat_messages (id, session_id, role, content, created_at)
      VALUES ('unbound', 'unbound', 'user', 'Unbound', '2026-08-12')`;
    expect(await h.adminSql()<Array<{ project_id: string }>>`
      SELECT project_id FROM project.chat_messages WHERE id = 'unbound'
    `).toEqual([{ project_id: "__legacy_unscoped__" }]);
  });
});
