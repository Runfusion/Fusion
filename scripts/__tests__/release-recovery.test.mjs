import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../release.mjs", import.meta.url));

function release({ channel = "beta", dryRun = false, auth = false, resume = true, subject, tagged = false, notes = true, answer = "y" } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "fusion-release-recovery-test-"));
  const version = channel === "beta" ? "0.78.0-beta.5" : "0.78.0";
  try {
    mkdirSync(join(cwd, "bin"));
    mkdirSync(join(cwd, "packages/cli"), { recursive: true });
    for (const path of ["package.json", "packages/cli/package.json"]) {
      writeFileSync(join(cwd, path), JSON.stringify({ version }));
    }
    writeFileSync(join(cwd, "CHANGELOG.md"), notes ? `# Changelog\n\n## ${version}\n\nRecovered notes.\n` : "# Changelog\n");
    const executable = `#!${process.execPath}
const fs = require('node:fs');
const command = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2).join(' ');
fs.appendFileSync('commands.log', command + ' ' + args + '\\n');
if (command === 'npm') process.exit(${auth ? 0 : 1});
if (command === 'pnpm') { console.error('BUILD_SENTINEL'); process.exit(23); }
if (args === 'rev-parse --abbrev-ref HEAD') console.log(${JSON.stringify(channel === "beta" ? "main" : "release")});
else if (args.startsWith('rev-list')) console.log('0');
else if (args.startsWith('log')) console.log(${JSON.stringify(subject ?? `chore(release): v${version}`)});
else if (args.startsWith('show-ref')) process.exit(${tagged ? 0 : 1});
`;
    for (const name of ["git", "npm", "pnpm"]) writeFileSync(join(cwd, "bin", name), executable, { mode: 0o755 });
    const result = spawnSync(process.execPath, [script, "--channel", channel, ...(resume ? ["--resume"] : []), ...(dryRun ? ["--dry-run"] : [])], {
      cwd, env: { ...process.env, PATH: `${join(cwd, "bin")}:${process.env.PATH}` }, input: `${answer}\n`, encoding: "utf8", timeout: 5000,
    });
    return { ...result, output: result.stdout + result.stderr, commands: readFileSync(join(cwd, "commands.log"), "utf8") };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const channel of ["beta", "stable"]) {
  test(`${channel} recovery previews the committed version without changesets or authentication`, () => {
    const result = release({ channel, dryRun: true });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Would resume/);
    assert.doesNotMatch(result.commands, /npm |pnpm |git (add|commit|push|tag)/);
  });

  test(`${channel} recovery rebuilds without another version bump after confirmation`, () => {
    const result = release({ channel, auth: true });
    assert.match(result.output, /BUILD_SENTINEL/);
    assert.match(result.commands, /npm whoami/);
    assert.match(result.commands, /pnpm build:full/);
    assert.doesNotMatch(result.commands, /changeset|release:version|git (add|commit|push|tag)/);
  });
}

test("invalid npm authentication stops a new release before version mutation", () => {
  const result = release({ resume: false });
  assert.equal(result.status, 1);
  assert.match(result.output, /npm login/);
  assert.doesNotMatch(result.commands, /pnpm |git (add|commit|push|tag)/);
});

test("resume refuses a version without its release commit", () => {
  const result = release({ dryRun: true, subject: "fix: unrelated change" });
  assert.equal(result.status, 1);
  assert.match(result.output, /release commit/);
});

test("resume refuses an already tagged release", () => {
  const result = release({ dryRun: true, tagged: true });
  assert.equal(result.status, 1);
  assert.match(result.output, /already tagged/);
});

test("resume refuses missing release notes", () => {
  const result = release({ dryRun: true, notes: false });
  assert.equal(result.status, 1);
  assert.match(result.output, /release notes .* missing/);
});

test("declining recovery performs no build or publish", () => {
  const result = release({ auth: true, answer: "n" });
  assert.equal(result.status, 0);
  assert.match(result.output, /Aborted by user/);
  assert.doesNotMatch(result.commands, /pnpm |git (add|commit|push|tag)/);
});
