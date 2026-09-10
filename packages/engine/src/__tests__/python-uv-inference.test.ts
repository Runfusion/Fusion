import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeUvDependencySelection, discoverPythonInterpreterVersions, parsePyProjectMetadata, satisfiesRequiresPython, uvCommandSelectsOptionalDependencies } from "../worktree/python-uv-inference.js";

const roots: string[] = [];
function root(files: Record<string, string>): string { const path = mkdtempSync(join(tmpdir(), "fn-9293-")); roots.push(path); for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text); return path; }
function environment(...names: string[]): NodeJS.ProcessEnv { const path = root({}); for (const name of names) writeFileSync(join(path, name), ""); return { PATH: path }; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("Python uv inference", () => {
  it("parses supported pyproject metadata including inline optional dependencies", () => {
    expect(parsePyProjectMetadata('[project]\nrequires-python = ">=3.11" # comment\noptional-dependencies = { test = ["pytest", "coverage"], docs = ["mkdocs"] }\n[dependency-groups]\nlint = ["ruff"]\n[tool.uv]\ndefault-groups = ["dev"]\npython-downloads = "never"')).toEqual({ parsed: true, requiresPython: ">=3.11", optionalDependencies: ["docs", "test"], dependencyGroups: ["lint"], defaultGroups: ["dev"], pythonDownloads: "never" });
    expect(parsePyProjectMetadata("[project.optional-dependencies]\ntest = [\n 'pytest', # quote # retained\n]\n")).toMatchObject({ parsed: true, optionalDependencies: ["test"] });
    expect(parsePyProjectMetadata("[project]\nrequires-python = [broken")).toMatchObject({ parsed: false });
  });

  it.each([ ["3.11", ">=3.10", true], ["3.11", ">3.11", false], ["3.11", "<=3.11", true], ["3.11", "<3.11", false], ["3.11", "==3.11.*", true], ["3.11", "!=3.10", true], ["3.11.4", "~=3.11", true], ["3.12", "~=3.11", true], ["3.12", "~=3.11.4", false], ["3.11", "===3.11", "undetermined"], ["3.11rc1", ">=3.11", "undetermined"] ] as const)("evaluates %s against %s", (version, specifier, expected) => {
    expect(satisfiesRequiresPython(version, specifier)).toBe(expected);
  });

  it("discovers only versioned PATH launchers and retains unversioned uncertainty", () => {
    const env = environment("python3.12", "python3.11", "python3", "not-python");
    expect(discoverPythonInterpreterVersions(env)).toEqual({ versions: ["3.11", "3.12"], hasUnversioned: true });
  });

  it("refuses disabled-download incompatible interpreters and ambiguous selections", () => {
    const incompatible = root({ "pyproject.toml": '[project]\nrequires-python = ">=3.99"\n[tool.uv]\npython-downloads = "never"' });
    expect(analyzeUvDependencySelection(incompatible, environment("python3.11"))).toMatchObject({ kind: "environment-incompatible", refusedCommand: "uv sync --frozen" });
    const ambiguous = root({ "pyproject.toml": '[project]\noptional-dependencies = { test = ["pytest", "coverage"] }\n[dependency-groups]\nlint = ["ruff"]' });
    expect(analyzeUvDependencySelection(ambiguous, environment("python3.11"))).toMatchObject({ kind: "configuration-required", command: "uv sync --frozen --all-extras --all-groups" });
    const uncertain = root({ "pyproject.toml": '[project]\nrequires-python = ">=3.99"\n[tool.uv]\npython-downloads = "never"' });
    expect(analyzeUvDependencySelection(uncertain, environment("python3"))).toMatchObject({ kind: "run" });
    const compatibleRelease = root({ "pyproject.toml": '[project]\nrequires-python = "~=3.11"\n[tool.uv]\npython-downloads = "never"' });
    expect(analyzeUvDependencySelection(compatibleRelease, environment("python3.12"))).toMatchObject({ kind: "run" });
  });

  it.each(["uv sync --extra test", "uv sync --all-extras", "uv sync --group=lint", "uv sync --all-groups", "uv sync --no-default-groups"])("recognizes explicit optional selection: %s", (command) => expect(uvCommandSelectsOptionalDependencies(command)).toBe(true));
  it("does not accept bare or substring optional selection", () => expect(uvCommandSelectsOptionalDependencies("uv sync --frozen --extra-ish")).toBe(false));
});
