import { describe, expect, it } from "vitest";
import {
  TraitRegistry,
  TraitRegistrationError,
} from "../workflows/trait-registry.js";
import type { TraitDefinition } from "../workflows/trait-types.js";
import type { WorkflowIrColumn } from "../workflows/workflow-ir-types.js";

function col(id: string, traits: string[]): WorkflowIrColumn {
  return { id, name: id, traits: traits.map((t) => ({ trait: t })) };
}

function builtin(id: string, def: Partial<TraitDefinition>): TraitDefinition {
  return { id, name: id, builtin: true, flags: {}, ...def };
}

function plugin(id: string, def: Partial<TraitDefinition>): TraitDefinition {
  return { id, name: id, flags: {}, ...def };
}

/** A registry seeded with a representative built-in set used across tests. */
function seeded(): TraitRegistry {
  const r = new TraitRegistry();
  r.register(builtin("intake", { flags: { intake: true } }));
  r.register(builtin("complete", { flags: { complete: true } }));
  r.register(builtin("archived", { flags: { archived: true, hiddenFromBoard: true } }));
  r.register(builtin("wip", { flags: { countsTowardWip: true } }));
  r.register(builtin("wip2", { flags: { countsTowardWip: true } }));
  r.register(builtin("merge-blocker", { flags: { mergeBlocker: true }, hooks: { guard: true } }));
  r.register(builtin("timing", { flags: { timing: true }, hooks: { onEnter: true, onExit: true } }));
  return r;
}

describe("TraitRegistry — registration", () => {
  it("rejects a duplicate trait id", () => {
    const r = new TraitRegistry();
    r.register(builtin("intake", { flags: { intake: true } }));
    expect(() => r.register(builtin("intake", { flags: { intake: true } }))).toThrowError(
      TraitRegistrationError,
    );
    try {
      r.register(builtin("intake", { flags: { intake: true } }));
    } catch (err) {
      expect((err as TraitRegistrationError).reason).toBe("duplicate-id");
    }
  });

  it("blocks a non-builtin from overriding a built-in namespace id", () => {
    const r = new TraitRegistry();
    r.register(builtin("complete", { flags: { complete: true } }));
    let caught: TraitRegistrationError | undefined;
    try {
      r.register(plugin("complete", { flags: {} }));
    } catch (err) {
      caught = err as TraitRegistrationError;
    }
    expect(caught).toBeInstanceOf(TraitRegistrationError);
    expect(caught?.reason).toBe("builtin-namespace-protected");
  });

  it("rejects a non-builtin declaring the restricted `complete` flag", () => {
    const r = new TraitRegistry();
    let caught: TraitRegistrationError | undefined;
    try {
      r.register(plugin("my-plugin:done", { flags: { complete: true } }));
    } catch (err) {
      caught = err as TraitRegistrationError;
    }
    expect(caught?.reason).toBe("restricted-flag");
  });

  it("rejects a non-builtin declaring the restricted `archived` flag", () => {
    const r = new TraitRegistry();
    let caught: TraitRegistrationError | undefined;
    try {
      r.register(plugin("my-plugin:arch", { flags: { archived: true } }));
    } catch (err) {
      caught = err as TraitRegistrationError;
    }
    expect(caught?.reason).toBe("restricted-flag");
  });

  it("rejects a non-builtin declaring a sync `guard` hook (built-in only)", () => {
    const r = new TraitRegistry();
    let caught: TraitRegistrationError | undefined;
    try {
      r.register(plugin("my-plugin:guard", { flags: {}, hooks: { guard: true } }));
    } catch (err) {
      caught = err as TraitRegistrationError;
    }
    expect(caught?.reason).toBe("restricted-guard-hook");
  });

  it("allows a non-builtin declaring async-only hooks", () => {
    const r = new TraitRegistry();
    expect(() =>
      r.register(
        plugin("my-plugin:gate", {
          flags: { gate: true },
          hooks: { gate: true, onEnter: true, onExit: true, releaseCondition: true },
        }),
      ),
    ).not.toThrow();
  });
});

describe("TraitRegistry — flag resolution", () => {
  it("merges effective flags across a column's traits (OR)", () => {
    const r = seeded();
    const flags = r.resolveColumnFlags(col("in-progress", ["wip", "timing"]));
    expect(flags.countsTowardWip).toBe(true);
    expect(flags.timing).toBe(true);
    expect(flags.complete).toBeUndefined();
  });

  it("ignores unknown trait ids in flag resolution", () => {
    const r = seeded();
    const flags = r.resolveColumnFlags(col("x", ["wip", "nope"]));
    expect(flags.countsTowardWip).toBe(true);
  });
});

describe("TraitRegistry — composition validator", () => {
  it("rejects complete + countsTowardWip with its reason code", () => {
    const r = seeded();
    const v = r.validateColumnTraits([col("c", ["complete", "wip"])]);
    expect(v.find((x) => x.code === "complete-with-wip")?.severity).toBe("error");
  });

  it("rejects two capacity (wip) traits on one column", () => {
    const r = seeded();
    const v = r.validateColumnTraits([col("c", ["wip", "wip2"])]);
    const hit = v.find((x) => x.code === "two-capacity-traits");
    expect(hit?.severity).toBe("error");
    expect(hit?.traitIds.sort()).toEqual(["wip", "wip2"]);
  });

  it("rejects complete + intake", () => {
    const r = seeded();
    const v = r.validateColumnTraits([col("c", ["complete", "intake"])]);
    expect(v.find((x) => x.code === "complete-with-intake")?.severity).toBe("error");
  });

  it("rejects archived + countsTowardWip", () => {
    const r = seeded();
    const v = r.validateColumnTraits([col("c", ["archived", "wip"])]);
    expect(v.find((x) => x.code === "archived-with-wip")?.severity).toBe("error");
  });

  it("rejects more than one intake column per workflow", () => {
    const r = seeded();
    const v = r.validateColumnTraits([col("a", ["intake"]), col("b", ["intake"])]);
    expect(v.find((x) => x.code === "multiple-intake-columns")?.severity).toBe("error");
  });

  it("a valid single-intake / clean column set passes", () => {
    const r = seeded();
    const v = r.validateColumnTraits([
      col("triage", ["intake"]),
      col("in-progress", ["wip", "timing"]),
      col("done", ["complete"]),
    ]);
    expect(v).toEqual([]);
  });

  it("conflicting boolean flags reject at save (validator), not at runtime", () => {
    const r = seeded();
    // The conflict is surfaced by the validator (save-time), not on flag merge.
    const flags = r.resolveColumnFlags(col("c", ["complete", "wip"]));
    expect(flags.complete && flags.countsTowardWip).toBe(true); // merge does not throw
    const v = r.validateColumnTraits([col("c", ["complete", "wip"])]);
    expect(v.some((x) => x.code === "complete-with-wip" && x.severity === "error")).toBe(true);
  });

  it("unknown trait is a save-blocking error in save mode", () => {
    const r = seeded();
    const v = r.validateColumnTraits([col("c", ["totally-unknown"])], "save");
    const hit = v.find((x) => x.code === "unknown-trait");
    expect(hit?.severity).toBe("error");
  });

  it("load-time re-validation degrades unknown trait to advisory, not error", () => {
    const r = seeded();
    const v = r.validateColumnTraits([col("c", ["totally-unknown"])], "load");
    const hit = v.find((x) => x.code === "unknown-trait");
    expect(hit?.severity).toBe("degraded");
    // The definition still "loads" — there is no error-severity violation.
    expect(v.some((x) => x.severity === "error")).toBe(false);
  });
});

describe("TraitRegistry — hook implementation DI", () => {
  it("resolves a declared hook with no registered impl to a no-op + audit warning", () => {
    const r = seeded();
    const { impl, warning } = r.resolveTraitHook("merge-blocker", "guard");
    expect(typeof impl).toBe("function");
    expect(impl?.()).toBeUndefined(); // no-op
    expect(warning?.kind).toBe("missing-hook-impl");
    expect(warning?.traitId).toBe("merge-blocker");
    expect(warning?.hookKind).toBe("guard");
  });

  it("resolves a registered impl without a warning", () => {
    const r = seeded();
    let called = false;
    r.registerTraitHookImpl("merge-blocker", "guard", () => {
      called = true;
      return "ok";
    });
    const { impl, warning } = r.resolveTraitHook("merge-blocker", "guard");
    expect(warning).toBeUndefined();
    expect(impl?.()).toBe("ok");
    expect(called).toBe(true);
  });

  it("returns no impl and no warning when the trait does not declare the hook", () => {
    const r = seeded();
    const { impl, warning } = r.resolveTraitHook("wip", "onEnter");
    expect(impl).toBeUndefined();
    expect(warning).toBeUndefined();
  });
});
