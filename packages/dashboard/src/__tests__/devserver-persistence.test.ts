// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDevServerConfigs, saveDevServerConfigs } from "../devserver-persistence.js";
import { createDevServerId, type DevServerConfig } from "../devserver-types.js";

describe("devserver-persistence", () => {
  const tempRoots = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(tempRoots).map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.clear();
  });

  const createTempRoot = async (prefix: string) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.add(root);
    return root;
  };

  it("saves and reloads multiple dev server configs", async () => {
    const root = await createTempRoot("devserver-persist-");
    const configs: DevServerConfig[] = [
      {
        id: createDevServerId("server-1"),
        name: "Frontend",
        command: "npm run dev",
        cwd: root,
        env: { NODE_ENV: "development" },
        autoStart: true,
      },
      {
        id: createDevServerId("server-2"),
        name: "Storybook",
        command: "npm run storybook",
        cwd: root,
        env: { STORYBOOK_MODE: "static" },
        autoStart: false,
      },
    ];

    await saveDevServerConfigs(root, configs);
    const loaded = await loadDevServerConfigs(root);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.id).toBe("server-1");
    expect(loaded[0]?.name).toBe("Frontend");
    expect(loaded[0]?.command).toBe("npm run dev");
    expect(loaded[0]?.cwd).toBe(root);
    expect(loaded[0]?.env).toEqual({ NODE_ENV: "development" });
    expect(loaded[0]?.autoStart).toBe(true);
    expect(loaded[1]?.id).toBe("server-2");
    expect(loaded[1]?.name).toBe("Storybook");
    expect(loaded[1]?.autoStart).toBe(false);
  });

  it("preserves exact config properties on reload", async () => {
    const root = await createTempRoot("devserver-persist-exact-");
    const config: DevServerConfig = {
      id: createDevServerId("exact-test"),
      name: "Exact Config",
      command: "pnpm dev --port 3000",
      cwd: "/custom/path",
      env: {
        CUSTOM_VAR: "value1",
        ANOTHER_VAR: "value2",
      },
      autoStart: true,
    };

    await saveDevServerConfigs(root, [config]);
    const [loaded] = await loadDevServerConfigs(root);

    expect(loaded).toEqual(config);
  });

  it("returns empty array when no configs have been saved", async () => {
    const root = await createTempRoot("devserver-persist-empty-");

    const loaded = await loadDevServerConfigs(root);
    expect(loaded).toEqual([]);
  });

  it("handles corrupted devserver.json gracefully", async () => {
    const root = await createTempRoot("devserver-persist-corrupt-");
    const configPath = join(root, ".fusion", "devserver.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, '{ "invalid json', "utf-8");

    const loaded = await loadDevServerConfigs(root);
    expect(loaded).toEqual([]);
  });

  it("handles empty devserver.json", async () => {
    const root = await createTempRoot("devserver-persist-empty-file-");
    const configPath = join(root, ".fusion", "devserver.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, '', "utf-8");

    const loaded = await loadDevServerConfigs(root);
    expect(loaded).toEqual([]);
  });

  it("handles devserver.json with missing configs array", async () => {
    const root = await createTempRoot("devserver-persist-missing-");
    const configPath = join(root, ".fusion", "devserver.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"other": "data"}', "utf-8");

    const loaded = await loadDevServerConfigs(root);
    expect(loaded).toEqual([]);
  });

  it("persists three or more servers correctly", async () => {
    const root = await createTempRoot("devserver-persist-multi-");
    const configs: DevServerConfig[] = [
      { id: createDevServerId("multi-1"), name: "Server 1", command: "npm run dev", cwd: root },
      { id: createDevServerId("multi-2"), name: "Server 2", command: "npm run storybook", cwd: root },
      { id: createDevServerId("multi-3"), name: "Server 3", command: "npm run start", cwd: root },
    ];

    await saveDevServerConfigs(root, configs);
    const loaded = await loadDevServerConfigs(root);

    expect(loaded).toHaveLength(3);
    expect(loaded.map((c) => c.id)).toEqual(["multi-1", "multi-2", "multi-3"]);
    expect(loaded.map((c) => c.name)).toEqual(["Server 1", "Server 2", "Server 3"]);
  });

  it("filters out invalid configs during load", async () => {
    const root = await createTempRoot("devserver-persist-filter-");
    const configPath = join(root, ".fusion", "devserver.json");
    await mkdir(dirname(configPath), { recursive: true });
    // Write manually with an invalid config (missing required fields)
    await writeFile(
      configPath,
      JSON.stringify({
        configs: [
          { id: "valid-1", name: "Valid", command: "npm run dev", cwd: root },
          { id: "invalid-1" }, // Missing required fields
          { name: "Also invalid" }, // Missing id
          { id: "valid-2", name: "Also Valid", command: "npm run start", cwd: root },
        ],
      }),
      "utf-8",
    );

    const loaded = await loadDevServerConfigs(root);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.id).toBe("valid-1");
    expect(loaded[1]?.id).toBe("valid-2");
  });

  it("overwrites existing configs when saving", async () => {
    const root = await createTempRoot("devserver-persist-overwrite-");

    const initialConfigs: DevServerConfig[] = [
      { id: createDevServerId("overwrite-1"), name: "Initial", command: "npm run dev", cwd: root },
    ];
    await saveDevServerConfigs(root, initialConfigs);

    const overwrittenConfigs: DevServerConfig[] = [
      { id: createDevServerId("overwrite-2"), name: "New Config", command: "npm run start", cwd: root },
    ];
    await saveDevServerConfigs(root, overwrittenConfigs);

    const loaded = await loadDevServerConfigs(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("overwrite-2");
    expect(loaded[0]?.name).toBe("New Config");
  });
});
