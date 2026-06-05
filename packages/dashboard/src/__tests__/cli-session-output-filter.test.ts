// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  neutralizeTerminalOutput,
  flushTerminalOutput,
  MAX_CARRY_LENGTH,
} from "../cli-session-output-filter.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

/** Run a single full chunk and return the output (asserting no carry leftover). */
function run(chunk: string): string {
  const { output, carry } = neutralizeTerminalOutput(chunk, "");
  return output + flushTerminalOutput(carry);
}

describe("neutralizeTerminalOutput", () => {
  it("passes plain text through untouched", () => {
    expect(run("hello world\n")).toBe("hello world\n");
  });

  it("strips OSC 52 clipboard-write sequences (BEL-terminated)", () => {
    const evil = `before${ESC}]52;c;ZXZpbA==${BEL}after`;
    const out = run(evil);
    expect(out).toBe("beforeafter");
    expect(out).not.toContain("52;");
  });

  it("strips OSC 52 clipboard-write sequences (ST-terminated)", () => {
    const evil = `x${ESC}]52;c;ZGF0YQ==${ST}y`;
    expect(run(evil)).toBe("xy");
  });

  it("strips the URI of an OSC 8 javascript: hyperlink but keeps the text", () => {
    const link = `${ESC}]8;;javascript:alert(1)${BEL}Click me${ESC}]8;;${BEL}`;
    const out = run(link);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("Click me");
    // The opening link should be present but with an empty URI.
    expect(out).toContain(`${ESC}]8;;`);
  });

  it("passes through OSC 8 https hyperlinks verbatim", () => {
    const link = `${ESC}]8;;https://example.com${BEL}Link${ESC}]8;;${BEL}`;
    const out = run(link);
    expect(out).toContain("https://example.com");
    expect(out).toContain("Link");
  });

  it("strips DSR (device status report) query sequences", () => {
    // ESC [ 6 n is a cursor-position report query; the terminal would answer it.
    const out = run(`a${ESC}[6nb`);
    expect(out).toBe("ab");
  });

  it("strips DA (device attributes) query sequences", () => {
    expect(run(`a${ESC}[cb`)).toBe("ab");
    expect(run(`a${ESC}[>cb`)).toBe("ab");
  });

  it("strips DECRQSS (DCS query) sequences", () => {
    const out = run(`a${ESC}P$qm${ST}b`);
    expect(out).toBe("ab");
  });

  it("preserves benign CSI sequences like SGR color", () => {
    const colored = `${ESC}[31mred${ESC}[0m`;
    expect(run(colored)).toBe(colored);
  });

  it("preserves cursor movement CSI (not a query)", () => {
    const moved = `${ESC}[2J${ESC}[H`;
    expect(run(moved)).toBe(moved);
  });

  it("handles an OSC 52 sequence split across two chunks", () => {
    const first = `before${ESC}]52;c;ZXZ`;
    const second = `pbA==${BEL}after`;
    const r1 = neutralizeTerminalOutput(first, "");
    // The unterminated OSC should be withheld in carry, not emitted.
    expect(r1.output).toBe("before");
    expect(r1.carry).toContain("52;");
    const r2 = neutralizeTerminalOutput(second, r1.carry);
    expect(r2.output).toBe("after");
    expect(r2.output + flushTerminalOutput(r2.carry)).not.toContain("52;");
  });

  it("handles a DSR query split across two chunks", () => {
    const r1 = neutralizeTerminalOutput(`a${ESC}[6`, "");
    expect(r1.output).toBe("a");
    const r2 = neutralizeTerminalOutput(`nb`, r1.carry);
    expect(r2.output).toBe("b");
  });

  it("withholds a lone trailing ESC as carry", () => {
    const r1 = neutralizeTerminalOutput(`hi${ESC}`, "");
    expect(r1.output).toBe("hi");
    expect(r1.carry).toBe(ESC);
    const r2 = neutralizeTerminalOutput(`[31mred`, r1.carry);
    expect(r2.output).toBe(`${ESC}[31mred`);
  });

  it("flushes an unterminated sequence at stream end (no infinite withhold)", () => {
    const r = neutralizeTerminalOutput(`text${ESC}]52;c;partial`, "");
    expect(r.output).toBe("text");
    // flush emits the residual literally rather than losing it forever.
    expect(flushTerminalOutput(r.carry)).toContain("partial");
  });

  it("bounds the carry so an unterminated sequence cannot grow unbounded", () => {
    const huge = `${ESC}]52;c;` + "A".repeat(MAX_CARRY_LENGTH + 100);
    const r = neutralizeTerminalOutput(huge, "");
    expect(r.carry.length).toBeLessThanOrEqual(MAX_CARRY_LENGTH);
  });

  it("drops (not flushes) an overflowing OSC 52 prefix so it cannot reconstruct across chunks", () => {
    // An unterminated OSC 52 grows past MAX_CARRY. The dangerous introducer must
    // NOT be emitted as literal — otherwise a terminator in the next chunk would
    // recombine at the client into a working OSC 52 clipboard write.
    const huge = `${ESC}]52;c;` + "A".repeat(MAX_CARRY_LENGTH + 100);
    const r1 = neutralizeTerminalOutput(huge, "");
    // Nothing reconstructable was emitted, and the carry was dropped.
    expect(r1.output).not.toContain(`${ESC}]`);
    expect(r1.output).not.toContain("52;");
    expect(r1.carry).toBe("");
    // The terminator arriving next has no held introducer to recombine with.
    const r2 = neutralizeTerminalOutput(`${BEL}visible`, r1.carry);
    const combined = r1.output + r2.output;
    expect(combined).not.toContain(`${ESC}]52;`);
    expect(r2.output).toContain("visible");
  });

  it("neutralizes a stream with OSC 52, OSC 8 js link, and a DSR query together", () => {
    const stream =
      `start${ESC}]52;c;ZXZpbA==${BEL}` +
      `${ESC}]8;;javascript:x${BEL}danger${ESC}]8;;${BEL}` +
      `${ESC}[6n` +
      `end`;
    const out = run(stream);
    expect(out).not.toContain("52;");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("start");
    expect(out).toContain("danger");
    expect(out).toContain("end");
    // No bare query passthrough.
    expect(out).not.toContain(`${ESC}[6n`);
  });
});
