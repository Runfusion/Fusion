import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import { useReports } from "../useReports.js";

describe("useReports", () => {
  it("loads reports", async () => {
    vi.spyOn(api, "listReports").mockResolvedValue([{ id: "R-1", title: "A" } as never]);
    vi.spyOn(api, "getReport").mockResolvedValue({ id: "R-1", title: "A" } as never);
    const { result } = renderHook(() => useReports({ addToast: vi.fn() }));
    await waitFor(() => expect(result.current.reports).toHaveLength(1));
  });
});
