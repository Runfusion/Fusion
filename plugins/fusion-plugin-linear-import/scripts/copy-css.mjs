import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "LinearImportView.css");
const dest = join(root, "dist", "LinearImportView.css");
if (existsSync(src)) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}
