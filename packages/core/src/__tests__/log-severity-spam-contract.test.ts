import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../process/logger.js";
import { logSeverityManifest } from "../../../engine/src/__tests__/log-severity-manifest.js";

/*
FNXC:EngineDiagnostics 2026-07-26-10:46:
Core mirrors engine FUSION_DEBUG behavior; both implementations must preserve
silent-by-default routine diagnostics and the TUI's info severity marker.
*/
describe("core logger debug gating", () => {
  afterEach(() => { delete process.env.FUSION_DEBUG; vi.restoreAllMocks(); });

  it.each(["1", "true", "all", "*", "core-test", "other,core-test"])
  ("emits an info-marked debug line when FUSION_DEBUG=%s", (value) => {
    process.env.FUSION_DEBUG = value;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("core-test").debug("routine");
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain("\0fnlvl=info\0[core-test] routine");
  });

  it("is silent when unset or its prefix is absent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("core-test").debug("routine");
    process.env.FUSION_DEBUG = "other";
    createLogger("core-test").debug("routine");
    expect(spy).not.toHaveBeenCalled();
  });
});

/*
FNXC:EngineDiagnostics 2026-07-26-11:12:
FN-8603 requires core diagnostics to use the shared logger rather than bare
console output, preserving severity markers and FUSION_DEBUG gating.
*/
function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "__test-utils__" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

describe("core diagnostic source contract", () => {
  // Logger implementation is the sole adapter allowed to write severity-marked console output.
  const bareConsoleAllowlist = new Set([join(__dirname, "..", "process", "logger.ts")]);

  it("pins each core demotion to one debug call site, not any louder severity", () => {
    for (const entry of logSeverityManifest.filter((entry) => entry.pkg === "core")) {
      const source = readFileSync(join(__dirname, "..", entry.file), "utf8");
      const matchingCalls = source.split("\n").filter((line) => line.includes(entry.anchor) && /\.(debug|log|warn|error)\(|console\.(log|warn|error)\(/.test(line));
      expect(matchingCalls, `${entry.file}: ${entry.anchor}`).toHaveLength(1);
      const [line] = matchingCalls;
      expect(line).toContain(`.${entry.severity}(`);
      expect(line).not.toMatch(/\.(log|warn|error)\(|console\.(log|warn|error)\(/);
    }
  });

  it("routes production diagnostics through createLogger", () => {
    for (const file of sourceFiles(join(__dirname, ".."))) {
      if (bareConsoleAllowlist.has(file)) continue;
      expect(withoutComments(readFileSync(file, "utf8")), file).not.toMatch(/console\.(log|warn|error)\(/);
    }
  });
});
