import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGeneratedCli } from "../generation/runner.js";
import type { GeneratedCliArtifact } from "../generation/types.js";

async function writeFixture(script: string): Promise<{ artifact: GeneratedCliArtifact; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "clipp-runner-"));
  const binPath = join(root, "fixture.mjs");
  await writeFile(binPath, script, "utf8");
  return {
    root,
    artifact: {
      draftId: "draft-1",
      slug: "fixture",
      binPath,
      entrypoint: "node",
      generatedAt: new Date().toISOString(),
    },
  };
}

describe("runGeneratedCli", () => {
  it("returns success output", async () => {
    const { artifact, root } = await writeFixture("console.log('ok-output')");
    const result = await runGeneratedCli({ artifact, endpointId: "x", params: { enabled: true }, cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok-output");
    expect(result.timedOut).toBe(false);
  });

  it("captures non-zero exit", async () => {
    const { artifact, root } = await writeFixture("console.error('bad-output'); process.exit(7)");
    const result = await runGeneratedCli({ artifact, endpointId: "x", params: {}, cwd: root });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("bad-output");
  });

  it("captures timeout", async () => {
    const { artifact, root } = await writeFixture("await new Promise((resolve) => setTimeout(resolve, 500)); console.log('late')");
    const result = await runGeneratedCli({ artifact, endpointId: "x", params: {}, timeoutMs: 1, cwd: root });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("redacts credentials from stdout and argv echo", async () => {
    const secret = "super-secret-value";
    const { artifact, root } = await writeFixture("console.log(process.env.CLIPP_CRED_API_KEY)");
    const result = await runGeneratedCli({ artifact, endpointId: "x", params: { token: secret }, credentials: { api_key: secret }, cwd: root });
    expect(result.stdout).not.toContain(secret);
    expect(result.argv.join(" ")).not.toContain(secret);
    expect(result.stdout).toContain("***");
  });
});
