#!/usr/bin/env node
// Cross-platform replacement for `cp src/*.css dist/ && mkdir -p dist/styles && cp src/styles/*.css dist/styles/`.
// The unix commands fail on Windows (cmd.exe), which broke the desktop EXE release build.
// Copies every .css file under src/ to the mirrored path under dist/, creating dirs as needed.
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const srcDir = join(root, "src");
const distDir = join(root, "dist");

async function* cssFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* cssFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".css")) yield full;
  }
}

for await (const file of cssFiles(srcDir)) {
  const dest = join(distDir, relative(srcDir, file));
  await mkdir(dirname(dest), { recursive: true });
  await cp(file, dest);
}
