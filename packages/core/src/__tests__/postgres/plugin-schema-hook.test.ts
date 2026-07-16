import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cePluginSchemaInit,
  cliPressPluginSchemaInit,
  DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS,
  reportsPluginSchemaInit,
  roadmapPluginSchemaInit,
  runLoadedPluginSchemaInitHooks,
  validatePluginPostgresSchema,
} from "../../postgres/plugin-schema-hook.js";

function transactionalDb(execute: ReturnType<typeof vi.fn>) {
  return {
    execute,
    transaction: vi.fn(async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => (
      callback({ execute })
    )),
  };
}

function executedSql(execute: ReturnType<typeof vi.fn>): string {
  return execute.mock.calls
    .map((call) => (call[0] as { queryChunks?: Array<{ value: string[] }> }).queryChunks
      ?.flatMap((chunk) => chunk.value).join("") ?? "")
    .join("\n");
}

describe("PostgreSQL plugin schema registry", () => {
  /*
  FNXC:PluginPostgresSchema 2026-07-14-18:45:
  Every bundled legacy onSchemaInit declaration requires either a named default
  PostgreSQL hook or a plugin-owned declarative PostgreSQL contract. Derive
  declarations from entrypoints so adding a SQLite hook cannot bypass the
  backend compatibility requirement.
  */
  it("registers every bundled plugin that declares onSchemaInit", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const pluginsRoot = join(repoRoot, "plugins");
    const declaredLegacyHooks = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("fusion-plugin-"))
      .flatMap((entry) => {
        const source = readFileSync(join(pluginsRoot, entry.name, "src", "index.ts"), "utf8");
        if (!/\bonSchemaInit\s*:/.test(source)) return [];
        const pluginId = source.match(/\bid\s*:\s*["']([^"']+)["']/)?.[1];
        if (!pluginId) throw new Error(`Bundled plugin ${entry.name} declares onSchemaInit without a literal manifest id`);
        return [{ pluginId, hasDeclarativePostgresSchema: /\bonPostgresSchemaInit\s*:/.test(source) }];
      })
      .sort();
    const registered = new Set(DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS.map((hook) => hook.pluginId));

    expect(declaredLegacyHooks).not.toHaveLength(0);
    expect(declaredLegacyHooks.filter(({ pluginId, hasDeclarativePostgresSchema }) => (
      !hasDeclarativePostgresSchema && !registered.has(pluginId)
    ))).toEqual([]);
  });

  it("runs the registered PostgreSQL hook instead of the legacy callback", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const legacy = vi.fn();
    await runLoadedPluginSchemaInitHooks(transactionalDb(execute) as never, [{
      pluginId: "fusion-plugin-even-realities-glasses",
      hook: legacy,
    }]);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({}));
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects a SQLite-only plugin without a PostgreSQL contract", async () => {
    await expect(runLoadedPluginSchemaInitHooks({} as never, [{
      pluginId: "third-party-sqlite-only",
      hook: vi.fn(),
    }])).rejects.toThrow(
      'Plugin "third-party-sqlite-only" declares legacy SQLite onSchemaInit but has no registered PostgreSQL schema hook',
    );
  });

  /* FNXC:PluginPostgresContract 2026-07-14-18:32: External plugins use declarative, project-owned DDL; Fusion applies isolation with its privileged executor without handing the plugin a database connection. */
  it("runs a third-party declarative schema and installs its isolation envelope", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const definition = {
      version: 1,
      tablePrefix: "external_fixture_",
      statements: [
        "CREATE TABLE IF NOT EXISTS project.external_fixture_rows (project_id text NOT NULL, id text NOT NULL, PRIMARY KEY (project_id, id))",
        "CREATE INDEX IF NOT EXISTS idx_external_fixture_rows ON project.external_fixture_rows(project_id, id)",
      ],
    } as const;

    await runLoadedPluginSchemaInitHooks(transactionalDb(execute) as never, [{
      pluginId: "external-fixture",
      postgresSchema: definition,
    }]);

    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("rejects unscoped or privileged third-party DDL", () => {
    expect(() => validatePluginPostgresSchema("external-fixture", {
      version: 1,
      tablePrefix: "bad_",
      statements: ["CREATE TABLE IF NOT EXISTS public.bad_rows (id text PRIMARY KEY)"],
    })).toThrow("project schema");
    expect(() => validatePluginPostgresSchema("external-fixture", {
      version: 1,
      tablePrefix: "bad_",
      statements: ["CREATE TABLE IF NOT EXISTS project.bad_rows (id text PRIMARY KEY)"],
    })).toThrow("project_id text NOT NULL");
    expect(() => validatePluginPostgresSchema("external-fixture", {
      version: 1,
      tablePrefix: "bad_",
      statements: ["DROP TABLE project.tasks"],
    })).toThrow("project schema");
  });

  /*
  FNXC:PluginPostgresContract 2026-07-14-22:42:
  The declarative PostgreSQL contract may evolve ordinary plugin columns, while Fusion exclusively owns tenant identity, RLS, table identity, keys, and grants. Reject every ALTER shape that could weaken that boundary before a privileged transaction begins.
  */
  it.each([
    "ALTER TABLE project.bad_rows DISABLE ROW LEVEL SECURITY",
    "ALTER TABLE project.bad_rows DROP COLUMN project_id",
    "ALTER TABLE project.bad_rows RENAME COLUMN project_id TO tenant_id",
    "ALTER TABLE project.bad_rows ALTER COLUMN project_id SET DEFAULT 'stolen'",
    "ALTER TABLE project.bad_rows DROP CONSTRAINT bad_rows_pkey",
    "ALTER TABLE project.bad_rows OWNER TO postgres",
  ])("rejects privileged third-party ALTER TABLE: %s", (statement) => {
    expect(() => validatePluginPostgresSchema("external-fixture", {
      version: 1,
      tablePrefix: "bad_",
      statements: [statement],
    })).toThrow("non-project_id data columns");
  });

  it("reinstalls isolation for tables changed only by a safe ALTER", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await runLoadedPluginSchemaInitHooks(transactionalDb(execute) as never, [{
      pluginId: "external-fixture",
      postgresSchema: {
        version: 2,
        tablePrefix: "external_fixture_",
        statements: ["ALTER TABLE project.external_fixture_rows ADD COLUMN IF NOT EXISTS notes text"],
      },
    }]);

    expect(execute).toHaveBeenCalledTimes(3);
    const envelope = (execute.mock.calls[2]?.[0] as { queryChunks: Array<{ value: string[] }> })
      .queryChunks.flatMap((chunk) => chunk.value).join("");
    expect(envelope).toContain('FORCE ROW LEVEL SECURITY');
    expect(envelope).toContain('project."external_fixture_rows"');
  });

  it("rolls back the whole contract when a later statement fails", async () => {
    const committed: string[] = [];
    const db = {
      transaction: vi.fn(async (callback: (tx: { execute: (query: unknown) => Promise<unknown> }) => Promise<unknown>) => {
        const pending: string[] = [];
        const tx = {
          execute: async (query: unknown) => {
            const text = (query as { queryChunks: Array<{ value: string[] }> }).queryChunks
              .flatMap((chunk) => chunk.value).join("");
            pending.push(text);
            if (text.includes("ALTER COLUMN notes SET NOT NULL")) throw new Error("fixture DDL failure");
            return [];
          },
        };
        const result = await callback(tx);
        committed.push(...pending);
        return result;
      }),
    };

    await expect(runLoadedPluginSchemaInitHooks(db as never, [{
      pluginId: "external-fixture",
      postgresSchema: {
        version: 2,
        tablePrefix: "external_fixture_",
        statements: [
          "CREATE TABLE IF NOT EXISTS project.external_fixture_rows (project_id text NOT NULL, id text NOT NULL, notes text, PRIMARY KEY (project_id, id))",
          "ALTER TABLE project.external_fixture_rows ALTER COLUMN notes SET NOT NULL",
        ],
      },
    }])).rejects.toThrow("fixture DDL failure");
    expect(committed).toEqual([]);
  });

  it("serializes concurrent contracts with the schema-applier advisory lock", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    let held = false;
    const waiters: Array<() => void> = [];
    const acquire = async () => {
      if (held) await new Promise<void>((resolve) => waiters.push(resolve));
      held = true;
      release = () => {
        held = false;
        waiters.shift()?.();
      };
    };
    const db = {
      transaction: async (callback: (tx: { execute: (query: unknown) => Promise<unknown> }) => Promise<unknown>) => {
        let ownsLock = false;
        try {
          return await callback({
            execute: async (query: unknown) => {
              const text = (query as { queryChunks: Array<{ value: string[] }> }).queryChunks
                .flatMap((chunk) => chunk.value).join("");
              if (text.includes("pg_advisory_xact_lock")) {
                await acquire();
                ownsLock = true;
                events.push("lock");
              } else {
                const table = text.match(/external_fixture_(one|two)/)?.[1] ?? "unknown";
                events.push(table);
                await Promise.resolve();
              }
              return [];
            },
          });
        } finally {
          if (ownsLock) release?.();
        }
      },
    };
    const contract = (suffix: "one" | "two") => runLoadedPluginSchemaInitHooks(db as never, [{
      pluginId: `fixture-${suffix}`,
      postgresSchema: {
        version: 1,
        tablePrefix: "external_fixture_",
        statements: [`CREATE TABLE IF NOT EXISTS project.external_fixture_${suffix} (project_id text NOT NULL, id text NOT NULL, PRIMARY KEY (project_id, id))`],
      },
    }]);

    await Promise.all([contract("one"), contract("two")]);
    expect(events).toEqual(["lock", "one", "one", "lock", "two", "two"]);
  });

  it("repairs Roadmap ownership outside legacy foreign keys and restores composite relationships", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    await roadmapPluginSchemaInit.init({ execute } as never);
    const ddl = executedSql(execute);

    const dropMilestoneFk = ddl.indexOf("DROP CONSTRAINT IF EXISTS roadmap_milestones_roadmap_id_fkey");
    const ownershipBackfill = ddl.indexOf("UPDATE project.roadmap_milestones milestone");
    const compositeMilestoneFk = ddl.lastIndexOf("FOREIGN KEY (project_id, roadmap_id)");
    const validation = ddl.indexOf("RAISE EXCEPTION 'Roadmap PostgreSQL upgrade found");
    expect(dropMilestoneFk).toBeGreaterThanOrEqual(0);
    expect(dropMilestoneFk).toBeLessThan(ownershipBackfill);
    expect(compositeMilestoneFk).toBeGreaterThan(validation);
    expect(ddl).toContain("PRIMARY KEY (project_id, id)");
    expect(ddl).toContain("FOREIGN KEY (project_id, milestone_id)");
    expect(ddl).toContain("roadmap.project_id = milestone.project_id");
    expect(ddl).toContain("roadmap.id = milestone.roadmap_id");
    expect(ddl).toContain("milestone.project_id = feature.project_id");
    expect(ddl).toContain("milestone.id = feature.milestone_id");
    expect(ddl).not.toContain("JOIN project.roadmaps roadmap ON roadmap.id = milestone.roadmap_id");
  });

  /*
  FNXC:PluginIndexIsolation 2026-07-14-23:55:
  Project-scoped plugin readers need tenant-leading lookup indexes across every status, relationship, and time query surface. Assert the generated reconciliation DDL rather than a second hand-maintained runtime inventory.
  */
  it.each([
    [cePluginSchemaInit, [
      'project.ce_sessions(project_id, status, updated_at DESC, id)',
      'project.ce_sessions(project_id, stage, created_at DESC, id)',
      'project.ce_pipeline_links(project_id, ce_pipeline_id, created_at DESC, id)',
      'project.ce_pipeline_state(project_id, status, updated_at DESC, ce_pipeline_id)',
      'project.ce_pipeline_sync_queue(project_id, processed_at, enqueued_at, id)',
    ]],
    [reportsPluginSchemaInit, [
      'project.reports(project_id, cadence, created_at DESC, id)',
      'project.reports(project_id, status, updated_at DESC, id)',
      'project.reports(project_id, period_start, period_end, id)',
    ]],
    [cliPressPluginSchemaInit, [
      'project.cli_press_cli_specs(project_id, service_id, created_at, id)',
      'project.cli_press_artifacts(project_id, cli_spec_id, created_at, id)',
      'project.cli_press_credentials(project_id, service_id, created_at, id)',
      'project.cli_press_service_settings(project_id, service_id, created_at, id)',
    ]],
  ] as const)("creates project_id-leading bundled-plugin secondary indexes", async (hook, definitions) => {
    const execute = vi.fn().mockResolvedValue([]);
    await hook.init({ execute } as never);
    const indexDdl = executedSql(execute);
    for (const definition of definitions) expect(indexDdl).toContain(definition);
  });

  /*
  FNXC:PluginLegacyOwnership 2026-07-14-21:41:
  A migration connection is intentionally not bound to fusion.project_id. Bundled plugin upgrades must recover pre-project rows only from an unambiguous central.projects singleton and must reject zero/multiple candidates instead of silently making preserved data invisible behind __legacy_unscoped__.
  */
  it.each([
    ["Roadmap", roadmapPluginSchemaInit, "$roadmap_upgrade$"],
    ["Compound Engineering", cePluginSchemaInit, "$ce_pipeline_upgrade$"],
    ["Reports", reportsPluginSchemaInit, "$reports_upgrade$"],
    ["CLI Printing Press", cliPressPluginSchemaInit, "$cli_press_upgrade$"],
  ] as const)("fails closed when %s legacy ownership is ambiguous", async (_name, hook, blockTag) => {
    const execute = vi.fn().mockResolvedValue([]);

    await hook.init({ execute } as never);

    expect(execute).toHaveBeenCalledTimes(5);
    const query = executedSql(execute);
    const upgradeStart = query.indexOf(`DO ${blockTag}`);
    const upgradeEnd = query.indexOf(blockTag, upgradeStart + blockTag.length);
    const upgrade = query.slice(upgradeStart, upgradeEnd + blockTag.length);

    expect(upgradeStart).toBeGreaterThanOrEqual(0);
    expect(upgrade).toContain("FROM central.projects");
    expect(upgrade).toContain("registered_project_count <> 1");
    expect(upgrade).toContain("SET project_id = singleton_project_id");
    expect(upgrade).toContain("RAISE EXCEPTION");
    expect(upgrade).toContain("project_id IN ('', '__legacy_unscoped__')");
    expect(upgrade).not.toContain("SET project_id = '__legacy_unscoped__'");
    expect(upgrade).not.toContain("current_setting('fusion.project_id'");
  });
});
