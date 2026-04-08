import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repoRoot = resolve(packageDir, "../..");

const sourceSvgPath = resolve(repoRoot, "packages/dashboard/app/public/logo.svg");
const outputDir = resolve(packageDir, "src/icons");

const iconSizes = [16, 32, 48] as const;

async function main(): Promise<void> {
  const sourceSvg = await readFile(sourceSvgPath, "utf8");
  const tintedSvg = sourceSvg.replaceAll("currentColor", "#333333");

  await mkdir(outputDir, { recursive: true });

  await Promise.all(
    iconSizes.map(async (size) => {
      const outputPath = resolve(outputDir, `tray-${size}.png`);
      await sharp(Buffer.from(tintedSvg), { density: 1024 })
        .resize(size, size, { fit: "contain" })
        .png({ compressionLevel: 9 })
        .toFile(outputPath);
    }),
  );

  console.log(`Generated ${iconSizes.length} tray icons in ${outputDir}`);
}

void main();
