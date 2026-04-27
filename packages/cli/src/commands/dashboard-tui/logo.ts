// FUSION block-letter logos using Unicode box-drawing + full blocks.
// The caller picks a size based on terminal dimensions and applies an
// all-blue vertical gradient.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ANSI Shadow font — 47 cols × 6 rows.
export const FUSION_LOGO_LINES = [
  "███████╗██╗   ██╗███████╗██╗ ██████╗ ███╗   ██╗",
  "██╔════╝██║   ██║██╔════╝██║██╔═══██╗████╗  ██║",
  "█████╗  ██║   ██║███████╗██║██║   ██║██╔██╗ ██║",
  "██╔══╝  ██║   ██║╚════██║██║██║   ██║██║╚██╗██║",
  "██║     ╚██████╔╝███████║██║╚██████╔╝██║ ╚████║",
  "╚═╝      ╚═════╝ ╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

// ANSI Shadow doubled vertically — each row of FUSION_LOGO_LINES rendered
// twice for a 2× taller block logo (47 cols × 12 rows). Preserves the same
// block-letter aesthetic; just scaled up. Used when the terminal has room.
export const FUSION_LOGO_LARGE_LINES = [
  "███████╗██╗   ██╗███████╗██╗ ██████╗ ███╗   ██╗",
  "███████╗██╗   ██╗███████╗██╗ ██████╗ ███╗   ██╗",
  "██╔════╝██║   ██║██╔════╝██║██╔═══██╗████╗  ██║",
  "██╔════╝██║   ██║██╔════╝██║██╔═══██╗████╗  ██║",
  "█████╗  ██║   ██║███████╗██║██║   ██║██╔██╗ ██║",
  "█████╗  ██║   ██║███████╗██║██║   ██║██╔██╗ ██║",
  "██╔══╝  ██║   ██║╚════██║██║██║   ██║██║╚██╗██║",
  "██╔══╝  ██║   ██║╚════██║██║██║   ██║██║╚██╗██║",
  "██║     ╚██████╔╝███████║██║╚██████╔╝██║ ╚████║",
  "██║     ╚██████╔╝███████║██║╚██████╔╝██║ ╚████║",
  "╚═╝      ╚═════╝ ╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
  "╚═╝      ╚═════╝ ╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

export const FUSION_TAGLINE = "multi node agent orchestrator";
export const FUSION_URL = "runfusion.ai";

// Walk up from this module to the @runfusion/fusion package.json to read
// the current CLI version. Returns "unknown" when the package.json can't
// be located (e.g. inside a bundled binary that strips it).
function readFusionVersion(): string {
  try {
    let cur = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkgPath = resolve(cur, "package.json");
      if (existsSync(pkgPath)) {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
        if (parsed.name === "@runfusion/fusion" && typeof parsed.version === "string") {
          return parsed.version;
        }
      }
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    // fall through to "unknown"
  }
  return "unknown";
}

export const FUSION_VERSION = readFusionVersion();
