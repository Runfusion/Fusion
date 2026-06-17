import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repoRoot = resolve(packageDir, "../..");

const sourceSvgPath = resolve(repoRoot, "packages/dashboard/app/public/logo.svg");
const outputDir = resolve(packageDir, "src/icons");
const dashboardPwaIconDir = resolve(repoRoot, "packages/dashboard/app/public/icons");

const iconSizes = [16, 32, 48] as const;
const dashboardPwaIconSizes = [192, 512] as const;

const APP_ICON_SIZE = 1024;
const APP_ICON_PADDING = 128;
const APP_ICON_BG = "#0d1117";
const APP_ICON_FG = "#58a6ff";
const DASHBOARD_PWA_ICON_BG = "#1a1a2e";
const DASHBOARD_PWA_ICON_FG = APP_ICON_FG;

async function renderIconTile(options: {
  tintedSvg: string;
  size: number;
  padding: number;
  background: string;
  outputPath: string;
}): Promise<void> {
  const markSize = options.size - options.padding * 2;
  const mark = await sharp(Buffer.from(options.tintedSvg), { density: 2048 })
    .resize(markSize, markSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: options.size,
      height: options.size,
      channels: 4,
      background: options.background,
    },
  })
    .composite([{ input: mark, top: options.padding, left: options.padding }])
    .png({ compressionLevel: 9 })
    .toFile(options.outputPath);
}

async function main(): Promise<void> {
  const sourceSvg = await readFile(sourceSvgPath, "utf8");
  const trayTintedSvg = sourceSvg.replaceAll("currentColor", "#333333");
  const appTintedSvg = sourceSvg.replaceAll("currentColor", APP_ICON_FG);
  const dashboardPwaTintedSvg = sourceSvg.replaceAll("currentColor", DASHBOARD_PWA_ICON_FG);

  await mkdir(outputDir, { recursive: true });
  await mkdir(dashboardPwaIconDir, { recursive: true });

  await Promise.all(
    iconSizes.map(async (size) => {
      const outputPath = resolve(outputDir, `tray-${size}.png`);
      await sharp(Buffer.from(trayTintedSvg), { density: 1024 })
        .resize(size, size, { fit: "contain" })
        .png({ compressionLevel: 9 })
        .toFile(outputPath);
    }),
  );

  await renderIconTile({
    tintedSvg: appTintedSvg,
    size: APP_ICON_SIZE,
    padding: APP_ICON_PADDING,
    background: APP_ICON_BG,
    outputPath: resolve(outputDir, "icon.png"),
  });

  /*
  FNXC:DashboardPWAIcons 2026-06-16-21:10:
  Dashboard mobile home-screen icons must be derived from packages/dashboard/app/public/logo.svg so the installed PWA, iOS apple-touch tile, and Android launcher glyph stay aligned with the in-app Fusion brand mark.
  Regenerate these assets and bump the dashboard service-worker cache whenever the canonical logo.svg brand mark changes.
  */
  await Promise.all(
    dashboardPwaIconSizes.map(async (size) => {
      await renderIconTile({
        tintedSvg: dashboardPwaTintedSvg,
        size,
        padding: Math.round(size * (APP_ICON_PADDING / APP_ICON_SIZE)),
        background: DASHBOARD_PWA_ICON_BG,
        outputPath: resolve(dashboardPwaIconDir, `icon-${size}.png`),
      });
    }),
  );

  console.log(
    `Generated ${iconSizes.length} tray icons and app icon in ${outputDir}; ${dashboardPwaIconSizes.length} dashboard PWA icons in ${dashboardPwaIconDir}`,
  );
}

void main();
