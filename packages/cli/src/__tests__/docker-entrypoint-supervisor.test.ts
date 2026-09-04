// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hasLiveSupervisingParent } from "../commands/dashboard.js";

const execFileAsync = promisify(execFile);

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const entrypoint = resolve(workspaceRoot, "scripts", "docker-entrypoint.sh");

/*
FNXC:DockerSourceUpdate 2026-09-01-01:22:
Behavioral coverage for the container entrypoint's restart supervisor. These run the REAL script
under `sh` against a stub CLI, because the invariants that matter are runtime ones no text assertion
can see: does exit 86 actually relaunch, does any other code actually reach the container, does the
child actually observe a supervisor pid that is its real parent (the thing hasLiveSupervisingParent
verifies before advertising restartSupported), and does --from-source actually refuse to silently
fall back to the image build.
*/

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-entrypoint-"));
  roots.push(root);
  return root;
}

/** Install a stub CLI at <root>/packages/cli/dist/bin.js. */
function installStubCli(root: string, body: string): void {
  const dir = join(root, "packages", "cli", "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bin.js"), body);
}

/** Stub that appends one JSON record per launch and exits with the code for that run index. */
const RECORDING_STUB = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const file = process.env.STUB_RECORD_FILE;
const previous = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
const runIndex = previous.length === 0 ? 0 : previous.split("\\n").length;
appendFileSync(file, JSON.stringify({
  runIndex,
  argv: process.argv.slice(2),
  supervisedFlag: process.env.FUSION_RESTART_SUPERVISED,
  supervisorPid: process.env.FUSION_SUPERVISOR_PID,
  realPpid: process.ppid,
}) + "\\n");
const codes = JSON.parse(process.env.STUB_EXIT_CODES);
process.exit(codes[Math.min(runIndex, codes.length - 1)]);
`;

interface StubRun {
  runIndex: number;
  argv: string[];
  supervisedFlag?: string;
  supervisorPid?: string;
  realPpid: number;
}

async function runEntrypoint(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", [entrypoint, ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function readRuns(file: string): StubRun[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StubRun);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("docker entrypoint restart supervisor", () => {
  it("relaunches the dashboard when it exits with the restart code and stops on the next clean exit", async () => {
    const root = makeRoot();
    installStubCli(root, RECORDING_STUB);
    const record = join(root, "runs.jsonl");

    const result = await runEntrypoint(["dashboard", "--host", "0.0.0.0"], {
      FUSION_APP_ROOT: join(root),
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([86, 86, 0]),
    });

    expect(result.code).toBe(0);
    const runs = readRuns(record);
    expect(runs).toHaveLength(3);
    // Arguments survive every relaunch verbatim — a restart must not silently change how the
    // dashboard was launched.
    for (const run of runs) expect(run.argv).toEqual(["dashboard", "--host", "0.0.0.0"]);
  });

  it("propagates a non-restart exit code to the container instead of relaunching", async () => {
    const root = makeRoot();
    installStubCli(root, RECORDING_STUB);
    const record = join(root, "runs.jsonl");

    const result = await runEntrypoint([], {
      FUSION_APP_ROOT: root,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([7]),
    });

    expect(result.code).toBe(7);
    expect(readRuns(record)).toHaveLength(1);
  });

  it("stamps a supervisor pid that the dashboard's own supervision check accepts", async () => {
    const root = makeRoot();
    installStubCli(root, RECORDING_STUB);
    const record = join(root, "runs.jsonl");

    await runEntrypoint([], {
      FUSION_APP_ROOT: root,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    const [run] = readRuns(record);
    expect(run.supervisedFlag).toBe("1");
    // The stamp must be the child's REAL parent: hasLiveSupervisingParent rejects a merely inherited
    // flag, so a supervisor that stamps someone else's pid leaves restartSupported false.
    expect(run.supervisorPid).toBe(String(run.realPpid));
    expect(
      hasLiveSupervisingParent(
        { FUSION_RESTART_SUPERVISED: run.supervisedFlag, FUSION_SUPERVISOR_PID: run.supervisorPid },
        run.realPpid,
      ),
    ).toBe(true);
  });

  it("forwards SIGTERM to the child and exits with the child's own status", async () => {
    const root = makeRoot();
    const ready = join(root, "ready");
    const signalled = join(root, "signalled");
    installStubCli(
      root,
      `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signalled)}, "term"); process.exit(0); });
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
    );

    const child = execFile("sh", [entrypoint], { env: { ...process.env, FUSION_APP_ROOT: root } });
    const exited = new Promise<number>((resolvePromise) => {
      child.on("exit", (code) => resolvePromise(code ?? -1));
    });
    await waitForFile(ready);
    child.kill("SIGTERM");

    // 0, not 143: the supervisor waits for the child's real status rather than reporting the signal
    // that interrupted its own `wait`, so `docker stop` records a graceful shutdown.
    expect(await exited).toBe(0);
    expect(existsSync(signalled)).toBe(true);
  });
});

describe("docker entrypoint --from-source", () => {
  it("runs the source checkout's CLI and strips the flag from the CLI arguments", async () => {
    const appRoot = makeRoot();
    const sourceRoot = makeRoot();
    installStubCli(appRoot, "process.exit(66);");
    installStubCli(sourceRoot, RECORDING_STUB);
    const record = join(sourceRoot, "runs.jsonl");

    const result = await runEntrypoint(["--from-source", "dashboard", "--host", "0.0.0.0"], {
      FUSION_APP_ROOT: appRoot,
      FUSION_SOURCE_ROOT: sourceRoot,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    expect(result.code).toBe(0);
    const runs = readRuns(record);
    expect(runs).toHaveLength(1);
    expect(runs[0].argv).toEqual(["dashboard", "--host", "0.0.0.0"]);
  });

  it("accepts the env equivalent of the flag", async () => {
    const appRoot = makeRoot();
    const sourceRoot = makeRoot();
    installStubCli(appRoot, "process.exit(66);");
    installStubCli(sourceRoot, RECORDING_STUB);
    const record = join(sourceRoot, "runs.jsonl");

    const result = await runEntrypoint(["dashboard"], {
      FUSION_FROM_SOURCE: "1",
      FUSION_APP_ROOT: appRoot,
      FUSION_SOURCE_ROOT: sourceRoot,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    expect(result.code).toBe(0);
    expect(readRuns(record)).toHaveLength(1);
  });

  it("fails loudly instead of silently falling back to the image build when no source build exists", async () => {
    const appRoot = makeRoot();
    const sourceRoot = makeRoot();
    installStubCli(appRoot, RECORDING_STUB);
    const record = join(appRoot, "runs.jsonl");

    const result = await runEntrypoint(["--from-source", "dashboard"], {
      FUSION_APP_ROOT: appRoot,
      FUSION_SOURCE_ROOT: sourceRoot,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    expect(result.code).toBe(1);
    // The actionable part: it names the path it looked for and says it will not fall back.
    expect(result.stderr).toContain(join(sourceRoot, "packages", "cli", "dist", "bin.js"));
    expect(result.stderr).toMatch(/refusing to fall back/i);
    // And it really did not run the image build.
    expect(readRuns(record)).toHaveLength(0);
  });
});

/** Poll for a file the stub writes when it is ready; keeps the signal test free of fixed sleeps. */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}
