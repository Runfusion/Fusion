import { describe, expect, it, vi } from "vitest";
import { QrScanner, parseQrConnectionPayload } from "../plugins/qr-scanner.js";

describe("qr-scanner", () => {
  it("parses JSON payload", () => {
    const parsed = parseQrConnectionPayload('{"serverUrl":"https://fusion.example.com","authToken":"abc"}');
    expect(parsed).toEqual({ serverUrl: "https://fusion.example.com", authToken: "abc" });
  });

  it("parses URL payload", () => {
    const parsed = parseQrConnectionPayload("https://fusion.example.com/dashboard?authToken=abc");
    expect(parsed).toEqual({ serverUrl: "https://fusion.example.com", authToken: "abc" });
  });

  it("parses remote-login rt token payload", () => {
    const parsed = parseQrConnectionPayload("https://fusion.example.com/remote-login?rt=abc");
    expect(parsed).toEqual({ serverUrl: "https://fusion.example.com", authToken: "abc" });
  });

  it("throws for empty payload", () => {
    expect(() => parseQrConnectionPayload("   ")).toThrow("QR scan returned empty payload");
  });

  it("throws for invalid payload", () => {
    expect(() => parseQrConnectionPayload("not-a-fusion-connection")).toThrow(
      "QR payload is not a valid Fusion connection payload",
    );
  });

  it("throws when scanner is unavailable", async () => {
    const scanner = new QrScanner();
    await expect(scanner.scanConnection()).rejects.toThrow("QR scanner is not available on this platform");
  });

  it("uses adapter scanning", async () => {
    const scanner = new QrScanner({ scan: vi.fn(async () => "https://fusion.example.com") });
    await expect(scanner.scanConnection()).resolves.toEqual({ serverUrl: "https://fusion.example.com", authToken: null });
  });
});
