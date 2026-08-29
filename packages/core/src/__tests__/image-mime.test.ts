import { describe, expect, it } from "vitest";
import { detectImageMimeFromBytes } from "../i18n/image-mime.js";

describe("detectImageMimeFromBytes", () => {
  it("detects PNG magic bytes", () => {
    expect(detectImageMimeFromBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("image/png");
  });

  it("detects JPEG magic bytes", () => {
    expect(detectImageMimeFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("detects GIF87a and GIF89a magic bytes", () => {
    expect(detectImageMimeFromBytes(Buffer.from("GIF87a"))).toBe("image/gif");
    expect(detectImageMimeFromBytes(Buffer.from("GIF89a"))).toBe("image/gif");
  });

  it("detects WEBP only when RIFF and WEBP segments are present", () => {
    expect(detectImageMimeFromBytes(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(detectImageMimeFromBytes(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04, 0x4e, 0x4f, 0x50, 0x45]))).toBeNull();
    expect(detectImageMimeFromBytes(Buffer.from([0x4e, 0x4f, 0x50, 0x45, 0x01, 0x02, 0x03, 0x04, 0x57, 0x45, 0x42, 0x50]))).toBeNull();
  });

  it("returns null for short or unknown bytes", () => {
    expect(detectImageMimeFromBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(detectImageMimeFromBytes(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBeNull();
    expect(detectImageMimeFromBytes(new Uint8Array())).toBeNull();
  });
});
