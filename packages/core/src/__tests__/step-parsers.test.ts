import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import {
  StepParserRegistry,
  StepParserRegistrationError,
  getStepParser,
  listStepParsers,
  registerStepParser,
  unregisterStepParser,
  parseStepHeadings,
  parseJsonSteps,
  __resetStepParserRegistryForTests,
  type StepParser,
} from "../step-parsers.js";

describe("step-parsers registry (U12, KTD-12)", () => {
  afterEach(() => {
    __resetStepParserRegistryForTests();
  });

  describe("step-headings built-in (byte-identical to legacy)", () => {
    const headings = () => getStepParser("step-headings")!;

    it("is registered as a built-in", () => {
      expect(getStepParser("step-headings")).toBeDefined();
      expect(listStepParsers().map((p) => p.id)).toContain("step-headings");
    });

    it("parses unannotated headings byte-identically to the legacy regex", () => {
      const content = `## Steps

### Step 0: Preflight

- [ ] x

### Step 1: Implementation

### Step 2: Testing
`;
      expect(headings().parse(content).steps).toEqual([
        { name: "Preflight" },
        { name: "Implementation" },
        { name: "Testing" },
      ]);
    });

    it("matches the legacy regex output exactly for varied unannotated headings", () => {
      const content = [
        "### Step 0: A",
        "### Step 12: Multi word title",
        "### Step 3 — dash but no annotation: Real Name",
        "### Step 4: trailing spaces here   ",
        "### Step 5 no colon at all",
        "not a step heading: ignored",
      ].join("\n");
      const legacy: { name: string }[] = [];
      const re = /^###\s+Step\s+\d+[^:]*:\s*(.+)$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        legacy.push({ name: m[1].trim() });
      }
      expect(headings().parse(content).steps).toEqual(legacy);
    });

    it("parses (depends: 1,2) into 0-indexed dependsOn", () => {
      expect(headings().parse("### Step 3 (depends: 1,2): Title").steps).toEqual([
        { name: "Title", dependsOn: [0, 1] },
      ]);
    });

    it("dedupes and sorts depends values", () => {
      expect(headings().parse("### Step 5 (depends: 3,1,3,2): T").steps).toEqual([
        { name: "T", dependsOn: [0, 1, 2] },
      ]);
    });

    it("empty depends list yields no dependsOn", () => {
      expect(headings().parse("### Step 2 (depends: ): T").steps).toEqual([
        { name: "T" },
      ]);
    });

    it("falls back deterministically on a malformed depends annotation", () => {
      expect(headings().parse("### Step 1 (depends: bad): Real Title").steps).toEqual([
        { name: "Real Title" },
      ]);
    });

    it("falls back deterministically when the annotation has no closing paren", () => {
      expect(headings().parse("### Step 1 (depends: 1,2 oops: Title").steps).toEqual([
        { name: "1,2 oops: Title" },
      ]);
    });

    it("the extracted parseStepHeadings still yields TaskStep[] with status", () => {
      // The store-facing function keeps the `status: "pending"` field.
      expect(parseStepHeadings("### Step 0: Preflight")).toEqual([
        { name: "Preflight", status: "pending" },
      ]);
    });
  });

  describe("json-steps built-in", () => {
    const json = () => getStepParser("json-steps")!;

    it("is registered as a built-in", () => {
      expect(getStepParser("json-steps")).toBeDefined();
    });

    it("parses a happy-path array of {name, depends}", () => {
      const content = JSON.stringify([
        { name: "Plan" },
        { name: "Implement", depends: [1] },
        { name: "Test", depends: [1, 2] },
      ]);
      expect(json().parse(content).steps).toEqual([
        { name: "Plan" },
        { name: "Implement", dependsOn: [0] },
        { name: "Test", dependsOn: [0, 1] },
      ]);
    });

    it("converts 1-indexed depends to 0-indexed dependsOn, deduped and sorted", () => {
      const content = JSON.stringify([{ name: "X", depends: [3, 1, 3, 2] }]);
      expect(json().parse(content).steps).toEqual([
        { name: "X", dependsOn: [0, 1, 2] },
      ]);
    });

    it("trims names and omits dependsOn when depends is empty", () => {
      const content = JSON.stringify([{ name: "  Spaced  ", depends: [] }]);
      expect(json().parse(content).steps).toEqual([{ name: "Spaced" }]);
    });

    it("parseJsonSteps is exported directly and matches the registry parser", () => {
      const content = JSON.stringify([{ name: "A" }]);
      expect(parseJsonSteps(content)).toEqual(json().parse(content));
    });

    it("throws a descriptive error on non-JSON input", () => {
      expect(() => json().parse("not json {")).toThrow(/not valid JSON/);
    });

    it("throws when the document is not an array", () => {
      expect(() => json().parse(JSON.stringify({ name: "X" }))).toThrow(
        /must be a JSON array/,
      );
    });

    it("throws when a step is missing its name", () => {
      expect(() => json().parse(JSON.stringify([{ foo: "bar" }]))).toThrow(
        /index 0 must have a non-empty string 'name'/,
      );
    });

    it("throws when a step name is blank", () => {
      expect(() => json().parse(JSON.stringify([{ name: "   " }]))).toThrow(
        /non-empty string 'name'/,
      );
    });

    it("throws when depends is not an array", () => {
      expect(() =>
        json().parse(JSON.stringify([{ name: "X", depends: 1 }])),
      ).toThrow(/'depends' must be an array/);
    });

    it("throws when depends contains a non-positive-integer", () => {
      expect(() =>
        json().parse(JSON.stringify([{ name: "X", depends: [0] }])),
      ).toThrow(/positive integers/);
      expect(() =>
        json().parse(JSON.stringify([{ name: "X", depends: ["1"] }])),
      ).toThrow(/positive integers/);
    });

    it("throws when an entry is not an object", () => {
      expect(() => json().parse(JSON.stringify(["just a string"]))).toThrow(
        /index 0 must be an object/,
      );
    });
  });

  describe("registry semantics", () => {
    it("rejects overwriting a built-in with a non-builtin id", () => {
      const reg = new StepParserRegistry();
      reg.register({ id: "step-headings", parse: () => ({ steps: [] }) }, { builtin: true });
      expect(() =>
        reg.register({ id: "step-headings", parse: () => ({ steps: [] }) }),
      ).toThrowError(StepParserRegistrationError);
      try {
        reg.register({ id: "step-headings", parse: () => ({ steps: [] }) });
      } catch (e) {
        expect((e as StepParserRegistrationError).reason).toBe(
          "builtin-namespace-protected",
        );
      }
    });

    it("rejects a duplicate registration", () => {
      const reg = new StepParserRegistry();
      const parser: StepParser = {
        id: "plugin:acme:custom",
        parse: () => ({ steps: [] }),
      };
      reg.register(parser);
      expect(() => reg.register(parser)).toThrowError(StepParserRegistrationError);
    });

    it("enforces the plugin id shape for non-builtins", () => {
      const reg = new StepParserRegistry();
      const bad = ["custom", "plugin:acme", "plugin::custom", "plugin:Acme:Custom", "other:acme:custom"];
      for (const id of bad) {
        expect(() => reg.register({ id, parse: () => ({ steps: [] }) })).toThrowError(
          StepParserRegistrationError,
        );
      }
      // A well-formed namespaced id is accepted.
      expect(() =>
        reg.register({ id: "plugin:acme:custom", parse: () => ({ steps: [] }) }),
      ).not.toThrow();
    });

    it("allows a built-in to use a non-namespaced id", () => {
      const reg = new StepParserRegistry();
      expect(() =>
        reg.register({ id: "step-headings", parse: () => ({ steps: [] }) }, { builtin: true }),
      ).not.toThrow();
    });

    it("rejects an invalid definition (no id / no parse)", () => {
      const reg = new StepParserRegistry();
      expect(() => reg.register({ id: "", parse: () => ({ steps: [] }) })).toThrowError(
        StepParserRegistrationError,
      );
      expect(() =>
        reg.register({ id: "plugin:acme:x" } as unknown as StepParser),
      ).toThrowError(StepParserRegistrationError);
    });

    it("round-trips register/unregister for a plugin parser via the shared API", () => {
      const id = "plugin:acme:json2";
      expect(getStepParser(id)).toBeUndefined();
      registerStepParser({ id, parse: () => ({ steps: [{ name: "ok" }] }) });
      expect(getStepParser(id)?.parse("").steps).toEqual([{ name: "ok" }]);
      expect(unregisterStepParser(id)).toBe(true);
      expect(getStepParser(id)).toBeUndefined();
      // Unregistering again (or a missing id) is a no-op false.
      expect(unregisterStepParser(id)).toBe(false);
    });

    it("never unregisters a built-in", () => {
      const reg = new StepParserRegistry();
      reg.register({ id: "step-headings", parse: () => ({ steps: [] }) }, { builtin: true });
      expect(reg.unregister("step-headings")).toBe(false);
      expect(reg.has("step-headings")).toBe(true);
    });

    it("getStepParser returns undefined for an unknown id", () => {
      expect(getStepParser("nope")).toBeUndefined();
      expect(getStepParser("plugin:acme:absent")).toBeUndefined();
    });
  });

  describe("parseStepsFromPrompt-through-registry parity (KTD-12)", () => {
    const harness = createTaskStoreTestHarness();

    beforeEach(async () => {
      await harness.beforeEach();
    });
    afterEach(async () => {
      await harness.afterEach();
    });

    const FIXTURES = [
      `## Steps

### Step 0: Preflight

### Step 1: Implementation

### Step 2: Testing
`,
      `# Task

## Steps

### Step 1: First

### Step 2 (depends: 1): Second

### Step 3 (depends: 1,2): Third
`,
      `### Step 1 (depends: bad): Real Title`,
    ];

    it("store path equals the direct step-headings parser on the same content", async () => {
      const store = harness.store();
      const rootDir = harness.rootDir();
      for (const content of FIXTURES) {
        const task = await store.createTask({ description: "parity" });
        const dir = join(rootDir, ".fusion", "tasks", task.id);
        await writeFile(join(dir, "PROMPT.md"), content);

        const viaStore = await store.parseStepsFromPrompt(task.id);
        // Direct parser yields { name, dependsOn? }; the store path re-applies
        // the `pending` status. Reconstruct the expected store shape from the
        // direct parse to assert identical behavior through both paths.
        const direct = parseStepHeadings(content);
        expect(viaStore).toEqual(direct);
      }
    });
  });
});
