import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhatsAppChatPairingPanel } from "../WhatsAppChatPairingPanel";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("WhatsAppChatPairingPanel", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a QR and instructions while awaiting scan", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "awaiting-qr", qrDataUrl: "data:image/png;base64,qr" }));
    render(<WhatsAppChatPairingPanel projectId="project-a" settings={{ pairingMode: "qr" }} />);

    expect(await screen.findByAltText("WhatsApp pairing QR code")).toHaveAttribute("src", "data:image/png;base64,qr");
    expect(screen.getByTestId("whatsapp-pairing-instructions")).toHaveTextContent("empty list blocks all inbound messages");
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/fusion-plugin-whatsapp-chat/status?projectId=project-a");
  });

  it("hides QR when connected and shows the JID", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "connected", jid: "15550001111@s.whatsapp.net" }));
    render(<WhatsAppChatPairingPanel />);

    expect(await screen.findByText(/Connected as 15550001111/)).toBeTruthy();
    expect(screen.queryByAltText("WhatsApp pairing QR code")).toBeNull();
  });

  it("shows connection errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "error", lastError: "session expired" }));
    render(<WhatsAppChatPairingPanel />);

    expect(await screen.findByText("session expired")).toBeTruthy();
  });

  it("posts logout with project scope and refreshes status", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "connected" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ status: "starting" }));
    render(<WhatsAppChatPairingPanel projectId="project-a" />);
    await screen.findByText("Status: connected");

    fireEvent.click(screen.getByTestId("whatsapp-pairing-logout"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/fusion-plugin-whatsapp-chat/logout?projectId=project-a",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ projectId: "project-a" }) }),
    ));
    expect(await screen.findByText("Status: starting")).toBeTruthy();
  });

  it("requests a code with a project-scoped body", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "awaiting-code" }))
      .mockResolvedValueOnce(jsonResponse({ pairingCode: "123-456" }))
      .mockResolvedValueOnce(jsonResponse({ status: "awaiting-code", pairingCode: "123-456" }));
    render(<WhatsAppChatPairingPanel projectId="project-a" settings={{ pairingMode: "code" }} />);
    const input = await screen.findByLabelText("Phone number (E.164 digits without +)");
    fireEvent.change(input, { target: { value: "15550001111" } });
    fireEvent.click(screen.getByRole("button", { name: "Request pairing code" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/fusion-plugin-whatsapp-chat/pair-code?projectId=project-a",
      expect.objectContaining({ body: JSON.stringify({ phoneNumber: "15550001111", projectId: "project-a" }) }),
    ));
    expect(await screen.findByText("123-456")).toBeTruthy();
  });
});
