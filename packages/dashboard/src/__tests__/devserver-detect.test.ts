// @vitest-environment node

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRIORITY_SCRIPTS,
  detectDevServerCommands,
  detectFramework,
} from "../devserver-detect.js";
import { loadDevServerConfigs, saveDevServerConfigs } from "../devserver-persistence.js";
import { createDevServerId, type DevServerConfig } from "../devserver-types.js";

async function writePackageJson(
  projectRoot: string,
  payload: Record<string, unknown>,
  subpath = "package.json",
): Promise<void> {
  const filePath = join(projectRoot, subpath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

describe("devserver-detect", () => {
  it("detects priority scripts from root package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "devserver-detect-"));
    await writePackageJson(root, {
      scripts: {
        dev: "vite",
        start: "node server.js",
      },
    });

    const detected = await detectDevServerCommands(root);

    expect(detected).toHaveLength(2);
    expect(detected[0]?.scriptName).toBe("dev");
    expect(detected[1]?.scriptName).toBe("start");
  });

  it("detectFramework recognizes common dev frameworks", () => {
    expect(detectFramework("vite")).toBe("vite");
    expect(detectFramework("next dev")).toBe("next");
    expect(detectFramework("ng serve --open")).toBe("angular");
  });

  it("only returns priority scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "devserver-detect-"));
    await writePackageJson(root, {
      scripts: {
        dev: "vite",
        build: "tsc",
        test: "vitest",
      },
    });

    const detected = await detectDevServerCommands(root);

    expect(detected).toHaveLength(1);
    expect(detected[0]?.scriptName).toBe("dev");
  });

  it("scans nested package.json files in apps/* and packages/*", async () => {
    const root = await mkdtemp(join(tmpdir(), "devserver-detect-"));
    await writePackageJson(root, { scripts: {} });
    await writePackageJson(
      root,
      {
        scripts: {
          dev: "next dev",
        },
      },
      "apps/web/package.json",
    );

    const detected = await detectDevServerCommands(root);

    expect(detected).toHaveLength(1);
    expect(detected[0]?.cwd).toBe(join(root, "apps", "web"));
    expect(detected[0]?.framework).toBe("next");
  });

  it("sorts results by PRIORITY_SCRIPTS order", async () => {
    const root = await mkdtemp(join(tmpdir(), "devserver-detect-"));
    expect(PRIORITY_SCRIPTS.indexOf("dev")).toBeLessThan(PRIORITY_SCRIPTS.indexOf("serve"));
    await writePackageJson(root, {
      scripts: {
        serve: "serve",
        dev: "vite",
      },
    });

    const detected = await detectDevServerCommands(root);

    expect(detected).toHaveLength(2);
    expect(detected[0]?.scriptName).toBe("dev");
    expect(detected[1]?.scriptName).toBe("serve");
  });

  it("returns empty array when scripts is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "devserver-detect-"));
    await writePackageJson(root, { scripts: {} });

    const detected = await detectDevServerCommands(root);
    expect(detected).toEqual([]);
  });

  it("returns empty array when root package.json is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "devserver-detect-"));

    const detected = await detectDevServerCommands(root);
    expect(detected).toEqual([]);
  });

  it("persists and reloads devserver configs", async () => {
    const root = await mkdtemp(join(tmpdir(), "devserver-config-"));
    const configs: DevServerConfig[] = [
      {
        id: createDevServerId("cfg-1"),
        name: "Frontend",
        command: "npm run dev",
        cwd: root,
        env: { NODE_ENV: "development" },
        autoStart: true,
      },
      {
        id: createDevServerId("cfg-2"),
        name: "Storybook",
        command: "npm run storybook",
        cwd: root,
      },
    ];

    await saveDevServerConfigs(root, configs);
    const loaded = await loadDevServerConfigs(root);

    expect(loaded).toEqual(configs);
  });
});
