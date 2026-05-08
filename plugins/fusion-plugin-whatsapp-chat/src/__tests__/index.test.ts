import { describe, expect, it, vi } from "vitest";
import plugin, { splitMessageForWhatsapp } from "../index.js";

describe("whatsapp plugin", () => {
  it("registers schema init hook", () => {
    expect(plugin.hooks?.onSchemaInit).toBeDefined();
  });

  it("registers pairing routes", () => {
    const paths = (plugin.routes ?? []).map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain("GET /status");
    expect(paths).toContain("GET /qr");
    expect(paths).toContain("POST /pair-code");
    expect(paths).toContain("POST /logout");
  });

  it("uses only pairing-era settings", () => {
    const schema = plugin.manifest.settingsSchema ?? {};
    expect(Object.keys(schema).sort()).toEqual([
      "agentSystemPrompt",
      "allowedSenders",
      "historyTurnLimit",
      "pairingMode",
      "pairingPhoneNumber",
    ]);
  });

  it("splits oversized messages", () => {
    const chunks = splitMessageForWhatsapp("x".repeat(9000));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(4096);
  });
});
