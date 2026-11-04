/**
 * RUFU-462 Step 1: the ceiling classifier is the only thing standing between "the host runs with a 16 GB
 * ceiling" and "the host has been dying at the 4 GB default for 28 restarts". Every launch shape that can
 * exist on a real host is asserted here against the full source matrix from the card's Surface Enumeration,
 * with the byte value taken from the injectable seam so no test depends on the machine's V8 default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getHeapStatistics } from "node:v8";
import {
  describeHeapCeilingRespawnCarry,
  describeHeapCeilingSource,
  formatHeapCeilingBytes,
  formatHeapCeilingCompact,
  formatHeapCeilingLine,
  getBootHeapCeiling,
  MAX_OLD_SPACE_FLAG,
  resetBootHeapCeilingForTesting,
  resolveHeapCeiling,
} from "../heap-ceiling.js";
import { formatBytes } from "../format-bytes.js";

const SIXTEEN_GIB = 16 * 1024 * 1024 * 1024 + 964 * 1024 * 1024;
const FOUR_GIB = 4 * 1024 * 1024 * 1024 + 96 * 1024 * 1024;

afterEach(() => {
  resetBootHeapCeilingForTesting();
});

describe("resolveHeapCeiling — source matrix", () => {
  it("reports v8-default when neither site declares the flag", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [],
      env: {},
      heapSizeLimitBytes: FOUR_GIB,
    });

    expect(ceiling).toEqual({ heapLimitBytes: FOUR_GIB, source: "v8-default", isV8Default: true });
  });

  it("classifies a flag declared only in NODE_OPTIONS", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=16384` },
      heapSizeLimitBytes: SIXTEEN_GIB,
    });

    expect(ceiling.source).toBe("NODE_OPTIONS");
    expect(ceiling.isV8Default).toBe(false);
    expect(ceiling.heapLimitBytes).toBe(SIXTEEN_GIB);
  });

  it("classifies a flag declared only in execArgv", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [`${MAX_OLD_SPACE_FLAG}=16384`],
      env: {},
      heapSizeLimitBytes: SIXTEEN_GIB,
    });

    expect(ceiling.source).toBe("execArgv");
    expect(ceiling.isV8Default).toBe(false);
  });

  it("accepts the two-token `--flag value` form in execArgv", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: ["--require", "some-loader", MAX_OLD_SPACE_FLAG, "8192"],
      env: {},
      heapSizeLimitBytes: SIXTEEN_GIB,
    });

    expect(ceiling.source).toBe("execArgv");
  });

  it("accepts the two-token form inside NODE_OPTIONS", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: `--require foo ${MAX_OLD_SPACE_FLAG} 8192 --title x` },
      heapSizeLimitBytes: SIXTEEN_GIB,
    });

    expect(ceiling.source).toBe("NODE_OPTIONS");
  });

  it("gives execArgv precedence when both sites declare it (Node applies argv flags last)", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [`${MAX_OLD_SPACE_FLAG}=16384`],
      env: { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=4096` },
      heapSizeLimitBytes: SIXTEEN_GIB,
    });

    expect(ceiling.source).toBe("execArgv");
  });

  it("treats unrelated NODE_OPTIONS content as no declaration at all", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: "--require=ts-node/register --title=fusion", MAX_OLD_SPACE_FLAG: undefined },
      heapSizeLimitBytes: FOUR_GIB,
    });

    expect(ceiling.source).toBe("v8-default");
    expect(ceiling.isV8Default).toBe(true);
  });

  it("ignores a present-but-non-numeric value: a garbled token is not a ceiling decision", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [`${MAX_OLD_SPACE_FLAG}=huge`],
      env: { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=banana` },
      heapSizeLimitBytes: FOUR_GIB,
    });

    expect(ceiling.source).toBe("v8-default");
  });

  it("ignores zero, negative, and dangling flag tokens", () => {
    for (const env of [
      { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=0` },
      { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=-1` },
      { NODE_OPTIONS: MAX_OLD_SPACE_FLAG },
    ]) {
      const ceiling = resolveHeapCeiling({ execArgv: [], env, heapSizeLimitBytes: FOUR_GIB });
      expect(ceiling.source, env.NODE_OPTIONS).toBe("v8-default");
    }
  });

  it("reports the resolved heap_size_limit, not arithmetic on the requested MiB", () => {
    // The flag asks for 16384 MiB; V8's resolved limit is larger. The reported number must be the fact.
    const ceiling = resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=16384` },
      heapSizeLimitBytes: SIXTEEN_GIB,
    });

    expect(ceiling.heapLimitBytes).toBe(SIXTEEN_GIB);
    expect(ceiling.heapLimitBytes).not.toBe(16384 * 1024 * 1024);
  });

  it("falls back to V8's own heap_size_limit when no byte seam is injected", () => {
    const ceiling = resolveHeapCeiling({ execArgv: [], env: {} });
    expect(ceiling.heapLimitBytes).toBe(getHeapStatistics().heap_size_limit);
  });

  it("classifies the LIVE launch environment the same way its contents dictate", () => {
    // Host-dependent by nature (this host exports NODE_OPTIONS=--max-old-space-size=16384; CI may not),
    // so the assertion is the invariant rather than a fixed answer: the default source may only be
    // reported when the real launch sites genuinely declare nothing.
    const ceiling = resolveHeapCeiling();
    const valueBearing = new RegExp(`${MAX_OLD_SPACE_FLAG}=\\d`);
    const declaredSomewhere =
      process.execArgv.some((a) => valueBearing.test(a)) || valueBearing.test(process.env.NODE_OPTIONS ?? "");

    // One-directional so a two-token or malformed real-world form cannot flip the assertion:
    // a value-bearing declaration must never be reported as the V8 default.
    if (declaredSomewhere) {
      expect(ceiling.isV8Default).toBe(false);
      expect(["execArgv", "NODE_OPTIONS"]).toContain(ceiling.source);
    } else {
      expect(["execArgv", "NODE_OPTIONS", "v8-default"]).toContain(ceiling.source);
    }
  });
});

describe("getBootHeapCeiling", () => {
  it("resolves once per process and returns the same snapshot", () => {
    const first = getBootHeapCeiling({ execArgv: [], env: {}, heapSizeLimitBytes: FOUR_GIB });
    const second = getBootHeapCeiling({ execArgv: [`${MAX_OLD_SPACE_FLAG}=16384`], env: {}, heapSizeLimitBytes: SIXTEEN_GIB });

    expect(second).toBe(first);
    expect(second.heapLimitBytes).toBe(FOUR_GIB);
  });

  it("matches the live process ceiling when nothing is injected (the /api/health contract)", () => {
    expect(getBootHeapCeiling().heapLimitBytes).toBe(getHeapStatistics().heap_size_limit);
  });
});

describe("operator-facing formatting", () => {
  it("renders GiB with two decimals using the shared byte formatter", () => {
    expect(formatHeapCeilingBytes(SIXTEEN_GIB)).toBe(formatBytes(SIXTEEN_GIB));
    expect(formatHeapCeilingBytes(16 * 1024 * 1024 * 1024)).toBe("16.00 GiB");
    expect(formatHeapCeilingBytes(512 * 1024 * 1024)).toBe("512.0 MiB");
  });

  it("names the carrying site for each of the three sources", () => {
    const base = { heapLimitBytes: SIXTEEN_GIB };
    expect(describeHeapCeilingSource({ ...base, source: "execArgv", isV8Default: false })).toContain("execArgv");
    expect(describeHeapCeilingSource({ ...base, source: "NODE_OPTIONS", isV8Default: false })).toContain("NODE_OPTIONS");
    expect(
      describeHeapCeilingSource({ heapLimitBytes: FOUR_GIB, source: "v8-default", isV8Default: true }),
    ).toContain("V8 default");
  });

  it("prints the full boot line for a declared and for a default ceiling", () => {
    expect(formatHeapCeilingLine({ heapLimitBytes: SIXTEEN_GIB, source: "NODE_OPTIONS", isV8Default: false })).toBe(
      `Heap ceiling: ${formatBytes(SIXTEEN_GIB)} (from ${MAX_OLD_SPACE_FLAG} in NODE_OPTIONS)`,
    );

    const line = formatHeapCeilingLine({ heapLimitBytes: FOUR_GIB, source: "v8-default", isV8Default: true });
    expect(line).toContain("V8 default");
    expect(line).toContain(MAX_OLD_SPACE_FLAG);
    expect(line).not.toContain("undefined");
  });

  it("never echoes a flag VALUE or env content in any rendered string", () => {
    const ceiling = resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=16384 --require /secret/path/leak-me.js`, SECRET: "hunter2" },
      heapSizeLimitBytes: SIXTEEN_GIB,
    });

    const rendered = [
      formatHeapCeilingLine(ceiling),
      formatHeapCeilingCompact(ceiling),
      describeHeapCeilingSource(ceiling),
      describeHeapCeilingRespawnCarry(ceiling),
    ].join(" | ");

    expect(rendered).not.toContain("16384");
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("leak-me");
    expect(rendered).not.toContain("NODE_OPTIONS=");
  });

  it("explains what the supervisor respawn does with each source", () => {
    expect(describeHeapCeilingRespawnCarry({ heapLimitBytes: SIXTEEN_GIB, source: "execArgv", isV8Default: false })).toContain("execArgv");
    expect(describeHeapCeilingRespawnCarry({ heapLimitBytes: SIXTEEN_GIB, source: "NODE_OPTIONS", isV8Default: false })).toContain("NODE_OPTIONS");
    expect(describeHeapCeilingRespawnCarry({ heapLimitBytes: FOUR_GIB, source: "v8-default", isV8Default: true })).toContain("V8 default");
  });
});
