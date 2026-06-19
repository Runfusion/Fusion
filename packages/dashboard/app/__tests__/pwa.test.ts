import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

type DecodedPng = {
  width: number;
  height: number;
  colorType: number;
  pixels: Buffer;
};

function getStandaloneDisplayModeBlock(css: string): string {
  const match = /@media\s*\(\s*display-mode:\s*standalone\s*\)\s*\{/.exec(css);
  expect(match).toBeTruthy();

  const start = match!.index;
  const open = css.indexOf("{", start);
  let depth = 1;
  let i = open + 1;

  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }

  return css.slice(start, i);
}

function decodeRgbaPng(filePath: string): DecodedPng {
  const buffer = readFileSync(filePath);
  const signature = buffer.subarray(0, 8).toString("hex");
  expect(signature).toBe("89504e470d0a1a0a");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let inputOffset = 0;
  let outputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= bytesPerPixel ? pixels[outputOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[outputOffset + x - stride] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[outputOffset + x - stride - bytesPerPixel] : 0;
      let value: number;

      if (filter === 0) {
        value = raw;
      } else if (filter === 1) {
        value = raw + left;
      } else if (filter === 2) {
        value = raw + up;
      } else if (filter === 3) {
        value = raw + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const predictor = left + up - upLeft;
        const pa = Math.abs(predictor - left);
        const pb = Math.abs(predictor - up);
        const pc = Math.abs(predictor - upLeft);
        const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = raw + paeth;
      } else {
        throw new Error(`Unsupported PNG filter ${filter} in ${filePath}`);
      }

      pixels[outputOffset + x] = value & 0xff;
    }

    inputOffset += stride;
    outputOffset += stride;
  }

  return { width, height, colorType, pixels };
}

describe("PWA configuration", () => {
  it("manifest defines required PWA fields and icon sizes", () => {
    const manifestPath = resolve(__dirname, "../public/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>;
    };

    expect(manifest.name).toBe("Fusion");
    expect(manifest.short_name).toBe("Fusion");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons).toContainEqual({
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    });
    expect(manifest.icons).toContainEqual({
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    });
  });

  it("index.html includes required PWA meta tags", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toContain('<link rel="manifest"');
    expect(indexHtml).toContain("apple-mobile-web-app-capable");
  });

  it("viewport meta includes viewport-fit=cover for safe-area support", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*viewport-fit=cover[^"]*"/i);
  });

  it("viewport meta keeps mobile baseline + safe-area support", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*width=device-width[^"]*"/i);
    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*initial-scale=1\.0[^"]*"/i);
    expect(indexHtml).toMatch(/<meta\s+name="viewport"[^>]*content="[^"]*viewport-fit=cover[^"]*"/i);
  });

  it("CSS includes display-mode: standalone rule with a :root token override only", () => {
    const cssContent = loadAllAppCss();
    const standaloneBlock = getStandaloneDisplayModeBlock(cssContent);

    expect(standaloneBlock).toContain("@media (display-mode: standalone)");
    expect(standaloneBlock).toMatch(/:root\s*\{[\s\S]*?--standalone-bottom-gap:\s*var\(--space-sm\)/);
    expect(standaloneBlock).not.toContain("#root {");
  });

  it("CSS defines --standalone-bottom-gap token in :root", () => {
    const cssContent = loadAllAppCss();

    // Base token defaults to 0px and standalone mode overrides it via :root inside display-mode media query.
    expect(cssContent).toContain("--standalone-bottom-gap: 0px");
    expect(cssContent).toContain("--standalone-bottom-gap: var(--space-sm)");
  });

  it("CSS applies standalone bottom gap via scoped mobile layout rules, not global #root padding", () => {
    const cssContent = loadAllAppCss();

    expect(cssContent).toMatch(/\.project-content--with-mobile-nav\s*\{[^}]*var\(--standalone-bottom-gap\)/);
    expect(cssContent).toMatch(/\.executor-status-bar\s*\{[^}]*var\(--standalone-bottom-gap\)/);
    expect(cssContent).not.toMatch(/#root\s*\{[^}]*var\(--standalone-bottom-gap\)/);
  });

  it("service worker contains lifecycle handlers and versioned cache name", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('addEventListener("install"');
    expect(swSource).toContain('addEventListener("fetch"');
    expect(swSource).toContain('addEventListener("activate"');
    expect(swSource).toContain('const CACHE_NAME = "fusion-cache-v4";');
  });

  it("service worker bypasses SSE requests instead of trying to cache them", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('text/event-stream');
    expect(swSource).toContain('url.pathname === "/api/events"');
    expect(swSource).toContain('url.pathname.startsWith("/api/events/")');
    expect(swSource).toContain("if (isEventStreamRequest) {");
    expect(swSource).toContain("return;");
  });

  it("service worker revalidates navigation requests so index.html cannot stay stale", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('request.mode === "navigate"');
    expect(swSource).toContain('request.destination === "document"');
    expect(swSource).toContain('url.pathname === "/index.html"');
    expect(swSource).toContain('[sw] navigation cache put failed');
  });

  it("service worker revalidates built assets so stale bundles cannot blank the app", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('url.pathname.startsWith("/assets/")');
    expect(swSource).toContain('request.destination === "script"');
    expect(swSource).toContain('request.destination === "style"');
    expect(swSource).toContain('if (isBuiltAssetRequest) {');
    expect(swSource).toContain('[sw] asset cache put failed');
    expect(swSource).toContain('[sw] asset cache lookup failed');
  });

  it("service worker activates updated code immediately", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain("await self.skipWaiting()");
    expect(swSource).toContain("await self.clients.claim()");
  });

  describe("logo assets", () => {
    it("logo.svg uses ring + swoosh geometry matching Header.tsx brand mark", () => {
      const logoSvg = readFileSync(resolve(__dirname, "../public/logo.svg"), "utf8");

      // Must contain the outer ring (circle with r=52, matching Header.tsx header-logo)
      expect(logoSvg).toContain('cx="64"');
      expect(logoSvg).toContain('cy="64"');
      expect(logoSvg).toContain('r="52"');
      expect(logoSvg).toContain('stroke-width="8"');

      // Must contain the swoosh/comet path shape (d attribute from Header.tsx)
      // The path starts with M26 101C... and creates the comet-like swoosh
      expect(logoSvg).toContain('d="M26 101');
      expect(logoSvg).toContain("fill=\"currentColor\"");

      // Must use SVG namespace
      expect(logoSvg).toContain("xmlns=");
    });

    it("logo.svg does not contain retired 4-circle glyph pattern", () => {
      const logoSvg = readFileSync(resolve(__dirname, "../public/logo.svg"), "utf8");

      // The old 4-circle glyph used circles at (44,44), (84,44), (44,84), (84,84) with r=20
      // Verify these specific circle positions are NOT present
      expect(logoSvg).not.toContain("cx=\"44\"");
      expect(logoSvg).not.toContain("cy=\"44\"");
      expect(logoSvg).not.toContain("r=\"20\"");
    });

    it("PWA icon files exist, decode to expected sizes, and are opaque non-blank PNGs", () => {
      const icons = [
        { path: resolve(__dirname, "../public/icons/icon-192.png"), size: 192 },
        { path: resolve(__dirname, "../public/icons/icon-512.png"), size: 512 },
      ];

      for (const icon of icons) {
        expect(existsSync(icon.path)).toBe(true);
        expect(statSync(icon.path).size).toBeGreaterThan(icon.size * 12);

        const png = decodeRgbaPng(icon.path);
        expect(png.width).toBe(icon.size);
        expect(png.height).toBe(icon.size);
        expect(png.colorType).toBe(6);

        let opaquePixels = 0;
        let transparentPixels = 0;
        let brandMarkPixels = 0;
        const brandBackground = [0x1a, 0x1a, 0x2e];

        for (let index = 0; index < png.pixels.length; index += 4) {
          const alpha = png.pixels[index + 3];
          if (alpha === 255) opaquePixels += 1;
          else transparentPixels += 1;

          const colorDistance =
            Math.abs(png.pixels[index] - brandBackground[0]) +
            Math.abs(png.pixels[index + 1] - brandBackground[1]) +
            Math.abs(png.pixels[index + 2] - brandBackground[2]);
          if (colorDistance > 8) brandMarkPixels += 1;
        }

        expect(transparentPixels).toBe(0);
        expect(opaquePixels).toBe(icon.size * icon.size);
        expect(brandMarkPixels).toBeGreaterThan(icon.size * icon.size * 0.1);
      }
    });

    it("wires the same PWA icons through manifest, apple touch, and service-worker precache", () => {
      const manifest = JSON.parse(readFileSync(resolve(__dirname, "../public/manifest.json"), "utf8")) as {
        icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
      };
      const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");
      const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
      const iconSources = ["/icons/icon-192.png", "/icons/icon-512.png"];

      for (const iconSource of iconSources) {
        expect(manifest.icons?.some((icon) => icon.src === iconSource && icon.purpose === "any")).toBe(true);
        expect(swSource).toContain(`"${iconSource}"`);
      }

      expect(indexHtml).toContain('<link rel="icon" type="image/svg+xml" href="/logo.svg" />');
      expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/icons/icon-192.png" />');
      expect(swSource).toContain('const CACHE_NAME = "fusion-cache-v4";');
    });
  });
});
