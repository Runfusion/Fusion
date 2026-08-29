import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPUTER_HANDLERS, runComputer } from "../computer.js";
import { COMPUTER_COMMAND_SURFACE, COMPUTER_ERROR_CODES, COMPUTER_SUBCOMMANDS, type ComputerSubcommand } from "../computer/contract.js";

const commandsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLAG_SCAN_SOURCES = [join(commandsDirectory, "computer.ts")] as const;
const ERROR_SCAN_SOURCES = [
  join(commandsDirectory, "computer.ts"),
  join(commandsDirectory, "computer", "adapter-macos.ts"),
  join(commandsDirectory, "computer", "adapter-unsupported.ts"),
  join(commandsDirectory, "computer", "snapshot-store.ts"),
] as const;
const GLOBAL_FLAG_LITERALS = new Set(["--help", "--json"]);

function flagsFor(name: ComputerSubcommand): string[] {
  const generic = ["--app", "App"];
  switch (name) {
    case "capabilities": case "permissions": case "list-apps": return [];
    case "list-windows": return generic;
    case "get-app-state": return [...generic, "--no-screenshot"];
    case "click": return [...generic, "--element-index", "7"];
    case "set-value": return [...generic, "--element-index", "7", "--value", "value"];
    case "type-text": return [...generic, "--text", "text"];
    case "press-key": return [...generic, "--key", "enter"];
    case "hotkey": return [...generic, "--keys", "cmd+k"];
    case "scroll": return [...generic, "--direction", "down"];
    case "drag": return [...generic, "--from-x", "1", "--from-y", "2", "--to-x", "3", "--to-y", "4"];
  }
}

async function envelope(args: string[]): Promise<Record<string, unknown>> {
  const output: string[] = [];
  await runComputer([...args, "--json"], {
    adapter: { listApps: async () => ({ apps: [{ bundleId: "com.example.App", name: "App", pid: 1 }] }) } as never,
    stdout: (text) => output.push(text),
  });
  return JSON.parse(output[0]!) as Record<string, unknown>;
}

function removeFlag(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  return index < 0 ? args : args.slice(0, index).concat(args[index + 1]?.startsWith("--") ? [] : [/* value is removed below */], args.slice(index + (args[index + 1]?.startsWith("--") ? 1 : 2)));
}

describe("COMPUTER_COMMAND_SURFACE anchors", () => {
  it("has the same runtime subcommand set as dispatch and the contract tuple", () => {
    const descriptor = Object.keys(COMPUTER_COMMAND_SURFACE).sort();
    expect(descriptor).toEqual([...COMPUTER_SUBCOMMANDS].sort());
    expect(descriptor).toEqual(Object.keys(COMPUTER_HANDLERS).sort());
  });

  it("keeps declared required and mutually-exclusive flags aligned with validation", async () => {
    for (const [name, entry] of Object.entries(COMPUTER_COMMAND_SURFACE) as [ComputerSubcommand, (typeof COMPUTER_COMMAND_SURFACE)[ComputerSubcommand]][]) {
      const complete = flagsFor(name);
      const valid = await envelope([name, ...complete]);
      expect((valid.error as { code?: string } | undefined)?.code, `${name} complete invocation`).not.toBe("INVALID_ARGUMENTS");
      for (const flag of entry.flags.filter((candidate) => candidate.required)) {
        const omitted = await envelope([name, ...removeFlag(complete, flag.flag)]);
        expect(omitted).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS", message: expect.stringContaining(flag.flag) } });
      }
      for (const flag of entry.flags.filter((candidate) => candidate.mutuallyExclusiveWith)) {
        const pair = [...complete, flag.flag, flag.valueKind === "boolean" ? "" : "value", flag.mutuallyExclusiveWith!, "value"].filter(Boolean);
        const rejected = await envelope([name, ...pair]);
        expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
      }
    }
  });

  it("enforces the conditional invocation forms documented by the descriptor", async () => {
    await expect(envelope(["set-value", "--app", "App", "--element-index", "7"]))
      .resolves.toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    await expect(envelope(["type-text", "--app", "App", "--text", "value", "--snapshot-id", "cs_0123456789"]))
      .resolves.toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    await expect(envelope(["hotkey", "--app", "App", "--keys", "cmd+k", "--snapshot-id", "cs_0123456789"]))
      .resolves.toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    await expect(envelope(["drag", "--app", "App", "--from-x", "1", "--from-y", "2"]))
      .resolves.toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    await expect(envelope(["drag", "--app", "App", "--from-x", "1", "--from-y", "2", "--to-x", "3", "--to-y", "4", "--from-element-index", "7", "--to-element-index", "9"]))
      .resolves.toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  });

  it("matches parser flag literals, including optional flags", () => {
    /* FNXC:ComputerUseSkill 2026-08-11-07:32: validateFlags is hand-written and ignores unknown
     * flags, so reflection cannot expose optional tokens. Scan this pinned argv-reading source instead.
     * This proves only source presence, not handler use; it cannot prove unknown-flag or invalid-choice
     * rejection, which the delivered CLI intentionally does not provide. */
    const parserFlags = new Set<string>();
    for (const source of FLAG_SCAN_SOURCES) {
      for (const match of readFileSync(source, "utf8").matchAll(/["'](--[a-z][a-z0-9-]*)["']/g)) parserFlags.add(match[1]!);
    }
    for (const flag of GLOBAL_FLAG_LITERALS) parserFlags.delete(flag);
    const declared = new Set(Object.values(COMPUTER_COMMAND_SURFACE).flatMap((entry) => entry.flags.map((flag) => flag.flag)));
    expect([...parserFlags].sort()).toEqual([...declared].sort());
  });

  it("keeps emitted envelope error literals within COMPUTER_ERROR_CODES", () => {
    const emitted = new Set<string>();
    for (const source of ERROR_SCAN_SOURCES) {
      const text = readFileSync(source, "utf8");
      for (const match of text.matchAll(/(?:new ComputerUseError\(|code:\s*)["']([A-Z][A-Z_]+)["']/g)) emitted.add(match[1]!);
    }
    expect(emitted.size).toBeGreaterThan(0);
    for (const code of emitted) expect(COMPUTER_ERROR_CODES, `${code} is not a contract code`).toContain(code as never);
  });
});
