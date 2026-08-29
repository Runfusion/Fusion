// FUSION block-letter logos using Unicode box-drawing + full blocks.
// The caller picks a size based on terminal dimensions and applies an
// all-blue vertical gradient.

import { getCliPackageVersion } from "@fusion/dashboard";

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

/*
FNXC:DashboardTUI 2026-07-12-00:00:
The dashboard TUI splash tagline must reflect the README's current "software factory" product positioning while keeping the logo, URL, and version copy unchanged.
*/
export const FUSION_TAGLINE = "software factory";
export const FUSION_URL = "runfusion.ai";

// Single source of truth: the dashboard's resolver also powers /api/health and
// /api/updates/check, so the splash/footer version and the Settings UI version
// (and the update-available banner) are guaranteed to agree.
export const FUSION_VERSION = getCliPackageVersion(import.meta.url);
