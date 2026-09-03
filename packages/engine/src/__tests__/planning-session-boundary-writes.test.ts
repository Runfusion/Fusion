import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { wrapToolsWithBoundary } from "../pi.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tool(name: string) {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: vi.fn().mockResolvedValue({ ok: true, content: [{ type: "text", text: name }] }),
  };
}

async function createBoundaryTools() {
  const projectRoot = await mkdtemp(join(tmpdir(), "fusion-fn-282-boundary-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "fusion-fn-282-outside-"));
  roots.push(projectRoot, outsideRoot);
  const fusionRoot = join(projectRoot, ".fusion");
  await mkdir(fusionRoot, { recursive: true });
  await symlink(outsideRoot, join(fusionRoot, "escape"));
  const originals = ["write", "edit", "bash", "fn_run_verification", "read", "grep", "find", "ls"].map(tool);
  const wrapped = wrapToolsWithBoundary(
    originals as never,
    projectRoot,
    projectRoot,
    [],
    true,
    [fusionRoot],
  );
  return {
    projectRoot,
    fusionRoot,
    outsideRoot,
    originals: Object.fromEntries(originals.map((entry) => [entry.name, entry])),
    wrapped: Object.fromEntries(wrapped.map((entry) => [entry.name, entry])),
  };
}

describe("planning read-only-root writable allowlist", () => {
  it.each(["write", "edit"])("allows %s only inside the declared .fusion root", async (name) => {
    const { fusionRoot, originals, wrapped } = await createBoundaryTools();
    const target = join(fusionRoot, "tasks", "FN-282", "PROMPT.md");

    await (wrapped[name] as never as { execute: (...args: unknown[]) => Promise<unknown> }).execute("call", { path: target });

    expect(originals[name].execute).toHaveBeenCalledOnce();
  });

  it.each(["write", "edit"])("refuses %s to source files and canonical symlink escapes", async (name) => {
    const { projectRoot, fusionRoot, originals, wrapped } = await createBoundaryTools();
    const execute = (wrapped[name] as never as { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }).execute;

    const sourceResult = await execute("source", { path: join(projectRoot, "packages", "core", "src", "index.ts") });
    const escapedResult = await execute("escape", { path: join(fusionRoot, "escape", "outside.ts") });

    expect(sourceResult).toMatchObject({ ok: false, error: expect.stringContaining("fn_task_prompt_write") });
    expect(escapedResult).toMatchObject({ ok: false, error: expect.stringContaining("fn_task_prompt_write") });
    expect(originals[name].execute).not.toHaveBeenCalled();
  });

  it("refuses an allowlist root that is itself a symlink outside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "fusion-fn-282-root-link-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "fusion-fn-282-root-link-outside-"));
    roots.push(projectRoot, outsideRoot);
    const fusionRoot = join(projectRoot, ".fusion");
    await symlink(outsideRoot, fusionRoot);
    const write = tool("write");
    const [wrapped] = wrapToolsWithBoundary([write] as never, projectRoot, projectRoot, [], true, [fusionRoot]);

    const result = await (wrapped as never as { execute: (...args: unknown[]) => Promise<Record<string, unknown>> })
      .execute("write", { path: join(fusionRoot, "tasks", "FN-282", "PROMPT.md") });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("fn_task_prompt_write") });
    expect(write.execute).not.toHaveBeenCalled();
  });

  it("refuses bash and verification while preserving project-root read tools", async () => {
    const { projectRoot, originals, wrapped } = await createBoundaryTools();
    const execute = async (name: string, params: Record<string, unknown>) =>
      await (wrapped[name] as never as { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }).execute(name, params);

    expect(await execute("bash", { command: "pwd", cwd: projectRoot })).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    expect(await execute("fn_run_verification", { command: "pnpm typecheck", cwd: projectRoot })).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    for (const name of ["read", "grep", "find", "ls"]) {
      expect(await execute(name, { path: join(projectRoot, "packages") })).toMatchObject({ ok: true });
      expect(originals[name].execute).toHaveBeenCalledOnce();
    }
    expect(originals.bash.execute).not.toHaveBeenCalled();
    expect(originals.fn_run_verification.execute).not.toHaveBeenCalled();
  });
});
