import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchAntigravityPrompt } from "../prompt-transport.js";
import { parseAntigravityStreamLine } from "../stream-parser.js";

const fixtureCli = fileURLToPath(new URL("./fixtures/agy-fixture-cli.mjs", import.meta.url));

describe("agy non-ACP compatibility harness", () => {
  it("accepts the documented streaming arguments and emits safe stream/tool lifecycle events", async () => {
    const lines = await new Promise<string[]>((resolve, reject) => {
      const child = spawn(process.execPath, [fixtureCli, "--print", "--input-format", "stream-json", "--output-format", "stream-json"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(stdout.trim().split("\n")) : reject(new Error(`fixture exited ${code}`)));
      child.stdin.end('{"prompt":"hello"}\n');
    });
    const events = lines.map(parseAntigravityStreamLine);
    expect(events).toMatchObject([
      { kind: "assistant-text", text: "Hello" },
      { kind: "thinking-delta", text: "Checking" },
      { kind: "tool-call-started", callId: "call-1", name: "fn_task_list", args: { limit: 1 } },
      { kind: "tool-call-completed", callId: "call-1", name: "fn_task_list", result: "[]", isError: false },
      { kind: "result", sessionId: "fixture-session", text: "Hello", isError: false },
    ]);
  });

  it("runs the fixture through the supervised minimal-environment stream transport", async () => {
    const streamed: string[] = [];
    const result = await launchAntigravityPrompt({ binary: fixtureCli, model: "fixture", cwd: process.cwd(), prompt: "hello", onText: (text) => streamed.push(text) });
    expect(result).toEqual({ text: "Hello", sessionId: "fixture-session" });
    expect(streamed).toEqual(["Hello"]);
  });

  it("reaps a real streaming child before cancellation settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fusion-antigravity-reap-"));
    const controller = new AbortController();
    let observedOutput!: () => void;
    const outputObserved = new Promise<void>((resolve) => { observedOutput = resolve; });
    try {
      const turn = launchAntigravityPrompt({ binary: fixtureCli, model: "fixture", cwd, prompt: "hold-open", signal: controller.signal, onText: observedOutput });
      await outputObserved;
      const pid = Number(readFileSync(join(cwd, "agy-fixture.pid"), "utf8"));
      controller.abort();
      await expect(turn).rejects.toThrow("Antigravity turn cancelled.");
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("contains malformed and unapproved tool-shaped events", () => {
    expect(parseAntigravityStreamLine("{")).toEqual({ kind: "unknown" });
    expect(parseAntigravityStreamLine('{"type":"tool.call.start","name":3}')).toEqual({ kind: "unknown" });
  });
});
