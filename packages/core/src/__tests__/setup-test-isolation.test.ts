import { describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMP_HOME_PREFIX = "fn-test-home-";

describe("test isolation setup", () => {
  it("process.env.HOME is overridden to a temp directory", () => {
    const home = process.env.HOME;
    const userProfile = process.env.USERPROFILE;

    expect(home).toBeDefined();
    expect(home).toContain(tmpdir());
    expect(home).toContain(TEMP_HOME_PREFIX);
    expect(userProfile).toBe(home);
  });

  it("homedir() resolves to the temp HOME", () => {
    const home = homedir();

    expect(home).toContain(tmpdir());
    expect(home).toContain(TEMP_HOME_PREFIX);
  });

  it("defaultGlobalDir() resolves under the temp HOME", async () => {
    const { defaultGlobalDir } = await import("../global-settings.js");
    const dir = defaultGlobalDir();

    expect(dir).toContain(tmpdir());
    expect(dir).toMatch(/fn-test-home-.*[\\/]\.fusion$/);
  });

  it("GlobalSettingsStore() without explicit dir throws under VITEST guard", async () => {
    const { GlobalSettingsStore } = await import("../global-settings.js");

    expect(() => new GlobalSettingsStore()).toThrow(
      "resolveGlobalDir() called without explicit dir during test execution. Pass a temp directory to avoid writing to real ~/.fusion/",
    );
  });

  it("cwd is not inside the repository .fusion directory", () => {
    const thisFile = fileURLToPath(import.meta.url);
    const repoRoot = resolve(dirname(thisFile), "../../../../");
    const repoFusionDir = join(repoRoot, ".fusion");

    expect(process.cwd().startsWith(repoFusionDir)).toBe(false);
  });
});
