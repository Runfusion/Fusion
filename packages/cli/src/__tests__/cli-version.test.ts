import { beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMock);

import {
  CLI_PACKAGE_NAME,
  MAX_PACKAGE_LOOKUP_DEPTH,
  readOwnCliVersion,
} from "../cli-version.js";

const startUrl = "file:///a/b/c/d/e/module.js";
const depthStartUrl = "file:///a/b/c/d/e/f/g/h/i/j/module.js";
const startDir = dirname(fileURLToPath(startUrl));

type Manifest = string | Error;

function manifestPath(index: number, directory = startDir): string {
  let currentDirectory = directory;
  for (let current = 0; current < index; current += 1) {
    currentDirectory = resolve(currentDirectory, "..");
  }
  return resolve(currentDirectory, "package.json");
}

function depthManifestPath(index: number): string {
  let directory = dirname(fileURLToPath(depthStartUrl));
  for (let current = 0; current < index; current += 1) {
    directory = resolve(directory, "..");
  }
  return resolve(directory, "package.json");
}

function configureManifests(manifests: Map<string, Manifest>): void {
  fsMock.existsSync.mockImplementation((path: string) => manifests.has(String(path)));
  fsMock.readFileSync.mockImplementation((path: string) => {
    const manifest = manifests.get(String(path));
    if (manifest instanceof Error) throw manifest;
    return manifest;
  });
}

function fusionManifest(version: string | number): string {
  return JSON.stringify({ name: CLI_PACKAGE_NAME, version });
}

describe("readOwnCliVersion", () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    configureManifests(new Map());
  });

  it("returns an immediate matching manifest without extra walking", () => {
    configureManifests(new Map([[manifestPath(0), fusionManifest("1.2.3")]]));

    expect(readOwnCliVersion(startUrl)).toBe("1.2.3");
    expect(fsMock.readFileSync).toHaveBeenCalledOnce();
    expect(fsMock.existsSync).toHaveBeenCalledWith(manifestPath(0));
  });

  it("walks ancestors one level at a time", () => {
    configureManifests(new Map([[manifestPath(2), fusionManifest("2.3.4")]]));

    expect(readOwnCliVersion(startUrl)).toBe("2.3.4");
    expect(fsMock.existsSync.mock.calls.map(([path]) => path)).toEqual([
      manifestPath(0),
      manifestPath(1),
      manifestPath(2),
    ]);
  });

  it("does not adopt a foreign package version", () => {
    const manifests = new Map<string, Manifest>();
    for (let index = 0; index < MAX_PACKAGE_LOOKUP_DEPTH; index += 1) {
      manifests.set(manifestPath(index), JSON.stringify({ name: "@fusion/dashboard", version: "1.0.0" }));
    }
    configureManifests(manifests);

    expect(readOwnCliVersion(startUrl)).toBeUndefined();
  });

  it("requires a string version", () => {
    configureManifests(new Map([[manifestPath(0), fusionManifest(5)]]));

    expect(readOwnCliVersion(startUrl)).toBeUndefined();
  });

  it("continues after a malformed manifest", () => {
    configureManifests(new Map([
      [manifestPath(0), "{not json"],
      [manifestPath(1), fusionManifest("3.4.5")],
    ]));

    expect(readOwnCliVersion(startUrl)).toBe("3.4.5");
  });

  it("continues after a manifest read error", () => {
    configureManifests(new Map([
      [manifestPath(0), new Error("EACCES")],
      [manifestPath(1), fusionManifest("4.5.6")],
    ]));

    expect(readOwnCliVersion(startUrl)).toBe("4.5.6");
  });

  it("does not inspect the ninth ancestor", () => {
    configureManifests(new Map([[depthManifestPath(MAX_PACKAGE_LOOKUP_DEPTH), fusionManifest("9.9.9")]]));

    expect(readOwnCliVersion(depthStartUrl)).toBeUndefined();
    expect(fsMock.existsSync).toHaveBeenCalledTimes(MAX_PACKAGE_LOOKUP_DEPTH);
  });

  it("inspects the final ancestor inside the depth limit", () => {
    configureManifests(new Map([[depthManifestPath(MAX_PACKAGE_LOOKUP_DEPTH - 1), fusionManifest("8.8.8")]]));

    expect(readOwnCliVersion(depthStartUrl)).toBe("8.8.8");
  });

  it("terminates at the filesystem root", () => {
    expect(readOwnCliVersion("file:///module.js")).toBeUndefined();
    expect(fsMock.existsSync).toHaveBeenCalledOnce();
  });

  it("returns undefined for an invalid URL without filesystem access", () => {
    expect(readOwnCliVersion("not-a-file-url")).toBeUndefined();
    expect(fsMock.existsSync).not.toHaveBeenCalled();
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });
});
