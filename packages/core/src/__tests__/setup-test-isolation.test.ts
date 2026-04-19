import { describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";

const TEMP_HOME_PREFIX = "fn-test-home-";

describe("test isolation setup", () => {
  it("process.env.HOME is overridden to a temp directory", () => {
    const home = process.env.HOME;

    expect(home).toBeDefined();
    expect(home).toContain(tmpdir());
    expect(home).toContain(TEMP_HOME_PREFIX);
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
});
