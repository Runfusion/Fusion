import { describe, expect, it, vi } from "vitest";
import { dispatchUpdateCliArgs, parseUpdateCliArgs } from "../commands/update.js";

describe("parseUpdateCliArgs", () => {
  it("parses every supported option without changing channel semantics", () => {
    expect(parseUpdateCliArgs(["--check", "--global", "--json", "--channel", "beta", "--force"])).toEqual({
      options: { check: true, global: true, json: true, channel: "beta", force: true },
    });
    expect(parseUpdateCliArgs(["--channel", "nightly"])).toEqual({ options: { channel: "nightly" } });
  });

  it.each([
    ["--totally-bogus-flag-xyz"],
    ["--beta"],
    ["-x"],
    ["something"],
  ])("rejects unknown update argv token %s", (token) => {
    expect(parseUpdateCliArgs([token])).toEqual({
      error: `Error: unknown option '${token}'. Valid options: --check, --global, --json, --channel <stable|beta>, --force.`,
    });
  });

  it("rejects a missing channel value and duplicate options", () => {
    expect(parseUpdateCliArgs(["--channel"])).toEqual({
      error: "Error: --channel requires a value: stable or beta.",
    });
    expect(parseUpdateCliArgs(["--channel", "--check"])).toEqual({
      error: "Error: --channel requires a value: stable or beta.",
    });
    expect(parseUpdateCliArgs(["--channel", "beta", "--channel", "stable"])).toEqual({
      error: "Error: duplicate option '--channel'.",
    });
    expect(parseUpdateCliArgs(["--check", "--check"])).toEqual({
      error: "Error: duplicate option '--check'.",
    });
  });
});

describe("bin update/upgrade argv dispatch", () => {
  it.each(["update", "upgrade"])("does not run an update for an unknown %s flag", async (command) => {
    const runUpdate = vi.fn(async () => {
      throw new Error("Already up to date.");
    });
    const writeError = vi.fn();
    const exit = vi.fn();

    await dispatchUpdateCliArgs(["--totally-bogus-flag-xyz"], { runUpdate, writeError, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("--totally-bogus-flag-xyz"));
    expect(runUpdate, `${command} must not reach success/status handling`).not.toHaveBeenCalled();
    expect(writeError.mock.calls.flat().join("\n")).not.toContain("Already up to date.");
  });

  it("blocks a stray positional without printing a successful JSON status", async () => {
    const runUpdate = vi.fn(async () => undefined);
    const writeError = vi.fn();
    const exit = vi.fn();

    await dispatchUpdateCliArgs(["--check", "--json", "something"], { runUpdate, writeError, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("something"));
    expect(runUpdate).not.toHaveBeenCalled();
    expect(writeError.mock.calls.flat().join("\n")).not.toContain('"updated":false');
  });

  it("passes valid argv through the same dispatch used by bin.ts", async () => {
    const runUpdate = vi.fn(async () => undefined);

    await dispatchUpdateCliArgs(["--check", "--json", "--channel", "beta"], { runUpdate });

    expect(runUpdate).toHaveBeenCalledWith({ check: true, json: true, channel: "beta" });
  });
});
