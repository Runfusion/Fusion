import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlamaCppProviderCard } from "../LlamaCppProviderCard";

const fetchLlamaCppStatus = vi.fn();
const setLlamaCppEnabled = vi.fn();

vi.mock("../../api", () => ({
  fetchLlamaCppStatus: (...args: unknown[]) => fetchLlamaCppStatus(...args),
  setLlamaCppEnabled: (...args: unknown[]) => setLlamaCppEnabled(...args),
}));

describe("LlamaCppProviderCard", () => {
  beforeEach(() => {
    fetchLlamaCppStatus.mockResolvedValue({
      enabled: false,
      ready: false,
      extension: { status: "ok" },
      server: { available: true, url: "http://127.0.0.1:8080", hasApiKey: false },
    });
    setLlamaCppEnabled.mockResolvedValue({ enabled: true, restartRequired: false });
  });

  it("renders and enables provider", async () => {
    render(<LlamaCppProviderCard authenticated={false} />);
    await waitFor(() => expect(fetchLlamaCppStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(setLlamaCppEnabled).toHaveBeenCalledWith(true));
  });
});
