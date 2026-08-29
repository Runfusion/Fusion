import { describe, expect, it, vi } from "vitest";
import { WebhookGlassesTransport } from "../transport.js";

describe("WebhookGlassesTransport", () => {
  it("posts cards to companion webhook", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const transport = new WebhookGlassesTransport({
      companionWebhookUrl: "https://companion.example",
      fetchImpl,
    });

    await transport.connect();
    await transport.pushCard({ id: "1", kind: "task", title: "A", lines: [], badge: "todo" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://companion.example/cards",
      expect.objectContaining({ method: "POST" }),
    );
    expect(transport.connected).toBe(true);
    expect(transport.status.lastPushAt).toEqual(expect.any(String));
  });

  it("tracks configuration and dispatches actions", async () => {
    const transport = new WebhookGlassesTransport();
    const handler = vi.fn();
    transport.onAction(handler);

    await transport.connect();
    await transport.receiveAction?.({ type: "quick-capture", text: "new task", timestamp: new Date().toISOString() });

    expect(transport.connected).toBe(false);
    expect(transport.status.endpointConfigured).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
