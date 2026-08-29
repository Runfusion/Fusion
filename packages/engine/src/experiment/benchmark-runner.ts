import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const STDOUT_TAIL_BYTES = 64 * 1024;

export interface BenchmarkRunOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  onProgress?: (partial: {
    stdoutChunk?: string;
    stderrChunk?: string;
    elapsedMs: number;
  }) => void;
  sessionId?: string;
}

export interface BenchmarkRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  truncatedTempFile?: string;
  timedOut: boolean;
}

export async function runBenchmark(
  opts: BenchmarkRunOptions,
): Promise<BenchmarkRunResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const env = { ...process.env, ...opts.env };

  return await new Promise<BenchmarkRunResult>((resolve, reject) => {
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env,
      shell: true,
      signal: opts.abortSignal,
    });

    let stdoutFull = "";
    let stdoutTail = "";
    let stdoutAll = "";
    let stderr = "";
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;
    let truncatedTempFile: string | undefined;
    let progressStdoutChunk = "";
    let progressStderrChunk = "";
    const emitProgress = () => {
      if (!opts.onProgress) {
        progressStdoutChunk = "";
        progressStderrChunk = "";
        return;
      }
      if (!progressStdoutChunk && !progressStderrChunk) {
        return;
      }
      opts.onProgress({
        stdoutChunk: progressStdoutChunk || undefined,
        stderrChunk: progressStderrChunk || undefined,
        elapsedMs: Date.now() - startedAt,
      });
      progressStdoutChunk = "";
      progressStderrChunk = "";
    };

    const progressTimer = setInterval(emitProgress, 500);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    const cleanup = () => {
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      progressStdoutChunk += text;
      stdoutBytes += Buffer.byteLength(text);

      stdoutAll += text;

      if (!truncated || stdoutBytes <= maxBufferBytes) {
        stdoutFull += text;
      } else {
        stdoutTail = (stdoutTail + text).slice(-STDOUT_TAIL_BYTES);
      }

      if (stdoutBytes > maxBufferBytes) {
        truncated = true;
        if (!stdoutTail) {
          stdoutTail = stdoutFull.slice(-STDOUT_TAIL_BYTES);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      progressStderrChunk += text;
      stderr += text;
    });

    child.on("error", (error) => {
      cleanup();
      if ((error as NodeJS.ErrnoException).name === "AbortError") {
        resolve({
          exitCode: 1,
          stdout: truncated ? (stdoutFull + stdoutTail).slice(-STDOUT_TAIL_BYTES) : stdoutFull,
          stderr,
          durationMs: Date.now() - startedAt,
          truncated,
          truncatedTempFile,
          timedOut: false,
        });
        return;
      }
      reject(error);
    });

    child.on("close", async (code, signal) => {
      cleanup();
      emitProgress();

      if (truncated) {
        try {
          const tempDir = await mkdtemp(path.join(os.tmpdir(), "fn-experiment-"));
          truncatedTempFile = path.join(
            tempDir,
            `fn-experiment-${opts.sessionId ?? "session"}-${Date.now()}.log`,
          );
          await writeFile(truncatedTempFile, stdoutAll, "utf8");
        } catch {
          truncatedTempFile = undefined;
        }
      }

      const durationMs = Date.now() - startedAt;
      const effectiveStdout = truncated
        ? (stdoutFull + stdoutTail).slice(-STDOUT_TAIL_BYTES)
        : stdoutFull;
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout: effectiveStdout,
        stderr,
        durationMs,
        truncated,
        truncatedTempFile,
        timedOut,
      });
    });
  });
}
