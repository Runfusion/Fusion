import test from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

function normalizeDockerSource(source) {
  return source.replace(/^\.\//, "").replace(/\/$/, "");
}

function readWorkspacePackageManifestPaths(root = repoRoot) {
  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  const workspace = YAML.parse(readFileSync(workspacePath, "utf8"));
  const entries = Array.isArray(workspace?.packages) ? workspace.packages : [];
  const manifestPaths = new Set();

  for (const entry of entries) {
    if (typeof entry !== "string" || entry.startsWith("!")) {
      continue;
    }

    for (const manifest of globSync(`${entry.replace(/\/$/, "")}/package.json`, {
      cwd: root,
      nodir: true,
    })) {
      manifestPaths.add(manifest.split(path.sep).join("/"));
    }
  }

  return manifestPaths;
}

function readBuilderPreInstallCopySources(dockerfile) {
  const builderStart = dockerfile.match(/^FROM\s+.*\s+AS\s+builder\s*$/im);
  assert.ok(builderStart?.index !== undefined, "Dockerfile must define a builder stage");

  const afterBuilder = dockerfile.slice(builderStart.index + builderStart[0].length);
  const nextStage = afterBuilder.search(/^FROM\s+/im);
  const builderStage = nextStage === -1 ? afterBuilder : afterBuilder.slice(0, nextStage);
  const install = builderStage.match(/RUN\s+pnpm\s+install\s+--frozen-lockfile\b/);
  assert.ok(install?.index !== undefined, "builder stage must run pnpm install --frozen-lockfile");

  const copied = [];
  for (const match of builderStage.slice(0, install.index).matchAll(/^COPY\s+(?:--\S+\s+)*(.*?)\s+\S+\s*$/gm)) {
    const sources = match[1].trim().split(/\s+/).map(normalizeDockerSource);
    copied.push(...sources);
  }
  return copied;
}

function findMissingWorkspaceManifests(manifests, copySources) {
  return [...manifests].filter((manifest) => !copySources.some((source) => (
    source === manifest || source === "." || manifest.startsWith(`${source}/`)
  ))).sort();
}

function readDockerfileCopiedManifestPaths() {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const copied = readBuilderPreInstallCopySources(dockerfile);
  return { copied, dockerfile };
}

test("Dockerfile builder pre-install copies cover every current workspace manifest", () => {
  const expected = readWorkspacePackageManifestPaths();
  const { copied } = readDockerfileCopiedManifestPaths();

  assert.deepEqual(findMissingWorkspaceManifests(expected, copied), []);
  assert.equal(new Set(copied).size, copied.length, "builder pre-install COPY sources must not be duplicated");
});

test("coverage rejects a selected plugin omitted before frozen install", () => {
  const expected = readWorkspacePackageManifestPaths();
  const omitted = [...expected].sort().find((manifest) => manifest.startsWith("plugins/"));
  assert.ok(omitted, "workspace fixture must include a plugin manifest");

  const completeSources = [...expected];
  const incompleteSources = completeSources.filter((source) => source !== omitted);
  assert.deepEqual(findMissingWorkspaceManifests(expected, incompleteSources), [omitted]);
});

test("coverage ignores post-install and runner copies while tolerating removed paths", () => {
  const expected = readWorkspacePackageManifestPaths();
  const omitted = [...expected].sort().find((manifest) => manifest.startsWith("plugins/"));
  assert.ok(omitted, "workspace fixture must include a plugin manifest");

  const builderCopies = [...expected]
    .filter((manifest) => manifest !== omitted)
    .map((manifest) => `COPY ${manifest} ./${manifest}`)
    .join("\n");
  const dockerfile = `FROM node:22-slim AS builder\n${builderCopies}\nRUN pnpm install --frozen-lockfile\nCOPY ${omitted} ./${omitted}\nFROM node:22-slim AS runner\nCOPY ${omitted} ./${omitted}`;
  const copied = readBuilderPreInstallCopySources(dockerfile);

  assert.deepEqual(findMissingWorkspaceManifests(expected, copied), [omitted]);
  assert.deepEqual(
    findMissingWorkspaceManifests(expected, [...expected, "plugins/not-in-workspace/package.json"]),
    [],
    "removed or nonexistent COPY paths must not affect selected workspace coverage",
  );
});
