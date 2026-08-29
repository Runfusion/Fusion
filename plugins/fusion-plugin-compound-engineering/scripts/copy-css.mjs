#!/usr/bin/env node
// Copies every .css file under src/ to the mirrored path under dist/.
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
