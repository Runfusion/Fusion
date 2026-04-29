import { describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_HOME_PREFIX = "fn-test-home-";

describe("test isolation setup", () => {
  it("overrides process.env.HOME to a temp directory", () => {
    const home = process.env.HOME;
    const userProfile = process.env.USERPROFILE;

    expect(home).toBeDefined();
    expect(home).toContain(tmpdir());
    expect(home).toContain(TEMP_HOME_PREFIX);
    expect(userProfile).toBe(home);
  });

  it("resolves homedir() to the temp HOME", () => {
    const home = homedir();

    expect(home).toContain(tmpdir());
    expect(home).toContain(TEMP_HOME_PREFIX);
  });

  it("resolves ~/.pi/agent/AGENTS.md under the temp HOME", () => {
    const agentsPath = join(homedir(), ".pi", "agent", "AGENTS.md");

    expect(agentsPath).toContain(tmpdir());
    expect(agentsPath).toContain(TEMP_HOME_PREFIX);
    expect(agentsPath).toMatch(/fn-test-home-.*[\\/]\.pi[\\/]agent[\\/]AGENTS\.md$/);
  });
});
