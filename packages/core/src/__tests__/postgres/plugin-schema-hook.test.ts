import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS,
  runLoadedPluginSchemaInitHooks,
  validatePluginPostgresSchema,
} from "../../postgres/plugin-schema-hook.js";

describe("PostgreSQL plugin schema registry", () => {
  /*
  FNXC:PluginPostgresSchema 2026-07-14-18:45:
  Every bundled legacy onSchemaInit declaration requires a named PostgreSQL equivalent. Derive the declarations from the bundled plugin entrypoints so adding a hook cannot leave a second hardcoded inventory green after the cutover.
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
        return [pluginId];
      })
      .sort();
    const registered = new Set(DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS.map((hook) => hook.pluginId));

    expect(declaredLegacyHooks).not.toHaveLength(0);
    expect(declaredLegacyHooks.filter((pluginId) => !registered.has(pluginId))).toEqual([]);
  });

  it("runs the registered PostgreSQL hook instead of the legacy callback", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const legacy = vi.fn();
    await runLoadedPluginSchemaInitHooks({ execute } as never, [{
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

    await runLoadedPluginSchemaInitHooks({ execute } as never, [{
      pluginId: "external-fixture",
      postgresSchema: definition,
    }]);

    expect(execute).toHaveBeenCalledTimes(3);
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
});
