import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7722: streaming spawn seam for `grok --prompt <text> --format json`
(verified contract: docs/grok-cli-contract.md). `cli-spawn.ts`'s
`runGrokCommand` buffers stdout/stderr until process close, which cannot
host line-by-line NDJSON streaming for the real-time onText bridge this
adapter needs. This module is the line-streaming counterpart: same
Windows-shell handling as `cli-spawn.ts` (Windows `grok.cmd`/`grok.bat` PATH
shims need shell:true; Unix/macOS stay direct-spawned), same "no raw
detached spawn/nohup" foreground-pipe pattern. Mirrors the Droid plugin's
`spawnDroid` (process-manager.ts) shape.
*/

export type GrokStreamProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface SpawnGrokStreamOptions {
  cwd?: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Spawn `grok --prompt <prompt> --format json [--model <model>] [--directory <cwd>]`
 * with piped stdio for line-by-line NDJSON consumption via readline.
 *
 * Does not read/buffer output itself — callers attach a `readline` interface
 * to `proc.stdout` (see `runtime-adapter.ts`).
 */
export function spawnGrokStream(binary: string, prompt: string, options?: SpawnGrokStreamOptions): GrokStreamProcess {
  const args: string[] = ["--prompt", prompt, "--format", "json"];
  const model = options?.model?.trim();
  if (model) {
    // FNXC:GrokCliRouting 2026-07-09-00:00: FN-7753 preserves a selected `grok-cli/*` model when auto-routing through the CLI; upstream verifies `--model <model>` alongside `--prompt`/`--format json`.
    args.push("--model", model);
  }
  if (options?.cwd) {
    args.push("--directory", options.cwd);
  }

  return spawn(binary, args, {
    cwd: options?.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    signal: options?.signal,
  }) as GrokStreamProcess;
}

/** Force-kill a Grok CLI streaming subprocess. Best-effort; never throws. */
export function forceKillGrokStream(proc: GrokStreamProcess): void {
  try {
    proc.kill("SIGKILL");
  } catch {
    // best effort
  }
}
