import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../check-runtime-skill-loader-drift.mjs";

function loader(name, { sentinel = true, extra = "" } = {}) {
  const sessionName = sentinel ? `stage${name}SessionSkills` : "stageSessionSkills";
  return [
    `export function ${sessionName}() { return "${name}"; }`,
    `const runtime = "${name.toLowerCase()}";`,
    ...Array.from({ length: 100 }, (_, index) => `// ${name} loader line ${index + 1}`),
    extra,
  ].join("\n");
}

function fixture(claude, grok) {
  const root = mkdtempSync(join(tmpdir(), "runtime-skill-loader-drift-"));
  const claudePath = join(root, "claude.ts");
  const grokPath = join(root, "grok.ts");
  writeFileSync(claudePath, claude);
  writeFileSync(grokPath, grok);
  return { root, claudePath, grokPath };
}

function captureErrors(callback) {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    return { result: callback(), errors };
  } finally {
    console.error = original;
  }
}

function withFixture(claude, grok, assertion) {
  const files = fixture(claude, grok);
  try {
    assertion(files);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
}

test("clean Claude-to-Grok rename pair passes", () => {
  const claude = loader("Claude");
  withFixture(claude, claude.replace(/Claude/g, "Grok").replace(/claude/g, "grok"), ({ claudePath, grokPath }) => {
    assert.equal(main([], { claudePath, grokPath }), 0);
  });
});

test("one-sided edit reports its differing line", () => {
  const claude = loader("Claude");
  const grok = `${claude.replace(/Claude/g, "Grok").replace(/claude/g, "grok")}\nif (process.platform === "darwin") stageGrokSessionSkills();`;
  withFixture(claude, grok, ({ claudePath, grokPath }) => {
    const { result, errors } = captureErrors(() => main([], { claudePath, grokPath }));
    assert.equal(result, 1);
    assert.match(errors.join("\n"), /first difference: line 104/);
  });
});

test("raw Grok token in Claude copy fails the cross-name guard", () => {
  const claude = `${loader("Claude")}\nconst accidental = "Grok";`;
  withFixture(claude, loader("Grok"), ({ claudePath, grokPath }) => {
    const { result, errors } = captureErrors(() => main([], { claudePath, grokPath }));
    assert.equal(result, 1);
    assert.match(errors.join("\n"), /raw Grok\/grok token/);
  });
});

test("missing input refuses to report success", () => {
  const files = fixture(loader("Claude"), loader("Grok"));
  try {
    const { result, errors } = captureErrors(() => main([], { claudePath: join(files.root, "missing.ts"), grokPath: files.grokPath }));
    assert.equal(result, 1);
    assert.match(errors.join("\n"), /refusing to report success: unable to read Claude loader/);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

test("empty or below-floor input refuses to report success", () => {
  withFixture("", loader("Grok"), ({ claudePath, grokPath }) => {
    const { result, errors } = captureErrors(() => main([], { claudePath, grokPath }));
    assert.equal(result, 1);
    assert.match(errors.join("\n"), /non-empty and contain at least 100 lines/);
  });
});

test("zero-substitution Claude fixture refuses to report success", () => {
  const generic = loader("Generic", { sentinel: false });
  withFixture(generic, generic, ({ claudePath, grokPath }) => {
    const { result, errors } = captureErrors(() => main([], { claudePath, grokPath }));
    assert.equal(result, 1);
    assert.match(errors.join("\n"), /canonicalization made zero Claude\/claude substitutions/);
  });
});

test("missing sentinel export refuses to report success", () => {
  const claude = loader("Claude", { sentinel: false });
  withFixture(claude, claude.replace(/Claude/g, "Grok").replace(/claude/g, "grok"), ({ claudePath, grokPath }) => {
    const { result, errors } = captureErrors(() => main([], { claudePath, grokPath }));
    assert.equal(result, 1);
    assert.match(errors.join("\n"), /expected sentinel exports/);
  });
});

test("real runtime loaders remain a clean rename pair", () => {
  assert.equal(main(), 0);
});
